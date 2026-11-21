#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <furi.h>
#include "fzmv.h"

/* The caller exclusively owns the speaker and DMA1 channel 1 while running. */
typedef struct {
    uint16_t dma[512];
    int16_t decoded[256];
    volatile uint32_t completed_halves;
    volatile uint32_t underruns;
    uint32_t prepared_halves;
    uint32_t first_sample;
    uint8_t volume;
    bool running;
    FuriMessageQueue* wake;
} AudioPwm;

bool audio_pwm_start(AudioPwm* audio, File* file, const FzmvInfo* info,
                     uint32_t first_sample, uint8_t volume, FuriMessageQueue* wake);
void audio_pwm_refill(AudioPwm* audio, File* file, const FzmvInfo* info);
uint32_t audio_pwm_position(const AudioPwm* audio);
void audio_pwm_stop(AudioPwm* audio);
