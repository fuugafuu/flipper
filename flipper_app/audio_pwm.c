#include "audio_pwm.h"

#include <string.h>
#include <furi_hal.h>
#include <stm32wbxx_ll_tim.h>
#include <stm32wbxx_ll_dma.h>

/* 64 MHz timer -> 125 kHz PWM carrier, 16 kHz update DMA clock. */
#define PWM_TIMER TIM16
#define SAMPLE_TIMER TIM2
#define DMA_HALF_SAMPLES 1024u
#define DMA_TOTAL_SAMPLES (DMA_HALF_SAMPLES * 2u)

static void audio_irq(void* context) {
    AudioPwm* audio = context;
    if(LL_DMA_IsActiveFlag_HT1(DMA1)) {
        LL_DMA_ClearFlag_HT1(DMA1);
        audio->completed_halves++;
    }
    if(LL_DMA_IsActiveFlag_TC1(DMA1)) {
        LL_DMA_ClearFlag_TC1(DMA1);
        audio->completed_halves++;
    }
    /* Main thread decodes and fills halves. No SD card I/O in interrupt context. */
    uint8_t event = 1;
    furi_message_queue_put(audio->wake, &event, 0);
}

static void fill_half(AudioPwm* audio, File* file, const FzmvInfo* info, uint32_t half) {
    const uint32_t sample_offset = audio->first_sample + half * DMA_HALF_SAMPLES;
    const uint32_t dst_offset = (half & 1u) * DMA_HALF_SAMPLES;
    const uint32_t block = sample_offset / 256u;
    const uint32_t skip = sample_offset % 256u;
    uint32_t cached_block = UINT32_MAX;
    for(uint32_t i = 0; i < DMA_HALF_SAMPLES; i++) {
        uint32_t sample = sample_offset + i;
        int16_t value = 0;
        if(sample < info->sample_count) {
            uint32_t which = block + (skip + i) / 256u;
            if(which != cached_block) {
                if(!fzmv_decode_pcm_block(file, info, which, audio->decoded)) {
                    audio->underruns++;
                    memset(audio->decoded, 0, sizeof(audio->decoded));
                }
                cached_block = which;
            }
            value = audio->decoded[(skip + i) % 256u];
        }
        /* Compress dynamic range for the low-efficiency piezo speaker.
         * The bounded transfer curve avoids hard clipping at full volume. */
        int32_t scaled = ((int32_t)value * audio->volume) / 100;
        int32_t magnitude = scaled < 0 ? -scaled : scaled;
        int32_t pwm = 128 + scaled * 124 / (magnitude + 7000);
        if(pwm < 2) pwm = 2;
        if(pwm > 253) pwm = 253;
        audio->dma[dst_offset + i] = (uint16_t)pwm;
    }
}

bool audio_pwm_start(AudioPwm* audio, File* file, const FzmvInfo* info,
                     uint32_t first_sample, uint8_t volume, FuriMessageQueue* wake) {
    memset(audio, 0, sizeof(*audio));
    audio->first_sample = first_sample;
    audio->volume = volume;
    audio->wake = wake;
    if(!furi_hal_speaker_acquire(100)) return false;
    furi_hal_bus_enable(FuriHalBusTIM2);

    fill_half(audio, file, info, 0);
    fill_half(audio, file, info, 1);
    audio->prepared_halves = 2;

    LL_TIM_InitTypeDef timer = {0};
    timer.Prescaler = 1;
    timer.Autoreload = 255;
    LL_TIM_Init(PWM_TIMER, &timer);
    LL_TIM_OC_InitTypeDef output = {0};
    output.OCMode = LL_TIM_OCMODE_PWM1;
    output.OCState = LL_TIM_OCSTATE_ENABLE;
    output.CompareValue = 128;
    LL_TIM_OC_Init(PWM_TIMER, LL_TIM_CHANNEL_CH1, &output);

    timer.Prescaler = 0;
    timer.Autoreload = 64000000u / FZMV_PCM_RATE - 1u;
    LL_TIM_Init(SAMPLE_TIMER, &timer);

    LL_DMA_ConfigAddresses(DMA1, LL_DMA_CHANNEL_1, (uint32_t)audio->dma,
                           (uint32_t)&PWM_TIMER->CCR1, LL_DMA_DIRECTION_MEMORY_TO_PERIPH);
    LL_DMA_SetDataLength(DMA1, LL_DMA_CHANNEL_1, DMA_TOTAL_SAMPLES);
    LL_DMA_SetPeriphRequest(DMA1, LL_DMA_CHANNEL_1, LL_DMAMUX_REQ_TIM2_UP);
    LL_DMA_SetDataTransferDirection(DMA1, LL_DMA_CHANNEL_1, LL_DMA_DIRECTION_MEMORY_TO_PERIPH);
    LL_DMA_SetChannelPriorityLevel(DMA1, LL_DMA_CHANNEL_1, LL_DMA_PRIORITY_VERYHIGH);
    LL_DMA_SetMode(DMA1, LL_DMA_CHANNEL_1, LL_DMA_MODE_CIRCULAR);
    LL_DMA_SetPeriphIncMode(DMA1, LL_DMA_CHANNEL_1, LL_DMA_PERIPH_NOINCREMENT);
    LL_DMA_SetMemoryIncMode(DMA1, LL_DMA_CHANNEL_1, LL_DMA_MEMORY_INCREMENT);
    LL_DMA_SetPeriphSize(DMA1, LL_DMA_CHANNEL_1, LL_DMA_PDATAALIGN_HALFWORD);
    LL_DMA_SetMemorySize(DMA1, LL_DMA_CHANNEL_1, LL_DMA_MDATAALIGN_HALFWORD);
    LL_DMA_ClearFlag_HT1(DMA1);
    LL_DMA_ClearFlag_TC1(DMA1);
    LL_DMA_EnableIT_TC(DMA1, LL_DMA_CHANNEL_1);
    LL_DMA_EnableIT_HT(DMA1, LL_DMA_CHANNEL_1);
    furi_hal_interrupt_set_isr(FuriHalInterruptIdDma1Ch1, audio_irq, audio);
    LL_DMA_EnableChannel(DMA1, LL_DMA_CHANNEL_1);
    LL_TIM_EnableDMAReq_UPDATE(SAMPLE_TIMER);
    LL_TIM_EnableAllOutputs(PWM_TIMER);
    LL_TIM_EnableCounter(PWM_TIMER);
    LL_TIM_EnableCounter(SAMPLE_TIMER);
    audio->running = true;
    return true;
}

void audio_pwm_refill(AudioPwm* audio, File* file, const FzmvInfo* info) {
    if(!audio->running) return;
    /* One refill per call. A delayed storage operation must never trap the
     * main playback loop while DMA continues advancing in the background. */
    if(audio->prepared_halves < audio->completed_halves + 2u) {
        /* A missed refill must not overwrite the half currently being played. */
        if(audio->prepared_halves < audio->completed_halves + 1u) {
            audio->underruns++;
            audio->prepared_halves = audio->completed_halves + 1u;
        }
        fill_half(audio, file, info, audio->prepared_halves);
        audio->prepared_halves++;
    }
}

uint32_t audio_pwm_position(const AudioPwm* audio) {
    uint32_t completed = audio->completed_halves;
    uint32_t remaining = LL_DMA_GetDataLength(DMA1, LL_DMA_CHANNEL_1);
    uint32_t progress = (DMA_TOTAL_SAMPLES - remaining) % DMA_HALF_SAMPLES;
    return audio->first_sample + completed * DMA_HALF_SAMPLES + progress;
}

void audio_pwm_stop(AudioPwm* audio) {
    if(!audio->running) return;
    LL_TIM_DisableDMAReq_UPDATE(SAMPLE_TIMER);
    LL_TIM_DisableCounter(SAMPLE_TIMER);
    LL_TIM_DisableCounter(PWM_TIMER);
    LL_TIM_DisableAllOutputs(PWM_TIMER);
    LL_DMA_DisableChannel(DMA1, LL_DMA_CHANNEL_1);
    LL_DMA_DisableIT_HT(DMA1, LL_DMA_CHANNEL_1);
    LL_DMA_DisableIT_TC(DMA1, LL_DMA_CHANNEL_1);
    furi_hal_interrupt_set_isr(FuriHalInterruptIdDma1Ch1, NULL, NULL);
    LL_DMA_ClearFlag_HT1(DMA1);
    LL_DMA_ClearFlag_TC1(DMA1);
    furi_hal_bus_disable(FuriHalBusTIM2);
    furi_hal_speaker_release();
    audio->running = false;
}
