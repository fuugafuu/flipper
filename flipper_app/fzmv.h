#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <storage/storage.h>

#define FZMV_WIDTH 128u
#define FZMV_HEIGHT 64u
#define FZMV_FRAME_BYTES 1024u
#define FZMV_PCM_RATE 16000u
#define FZMV_PCM_BLOCK_SAMPLES 256u
#define FZMV_PCM_BLOCK_BYTES 132u

typedef struct {
    uint16_t version;
    uint8_t playback_mode; /* 0 cinema, 1 retro, 2 tracker */
    bool pcm_audio;
    uint16_t fps;
    uint32_t frame_count;
    uint32_t tick_count;
    uint32_t frame_index_offset;
    uint32_t frame_data_offset;
    uint32_t audio_offset;
    uint32_t duration_ms;
    uint32_t sample_count;
    uint32_t file_size;
} FzmvInfo;

typedef struct {
    uint16_t frequency;
    uint8_t gain;
    uint8_t gate;
} FzmvTone;

/* The caller owns the Storage file and must keep it open. */
bool fzmv_open(File* file, FzmvInfo* info, const char** error);

/* A row-major, MSB-first bitmap, matching the website's encodeClip().
 * previous_index must be UINT32_MAX when previous_frame is unavailable.
 * Seeking backwards starts from the nearest preceding raw/RLE keyframe. */
bool fzmv_frame_at(
    File* file,
    const FzmvInfo* info,
    uint32_t index,
    uint32_t previous_index,
    uint8_t previous_frame[FZMV_FRAME_BYTES],
    const char** error);

/* u8g2's Flipper screen buffer is 8 vertical pages, LSB=top pixel. */
void fzmv_to_display(const uint8_t frame[FZMV_FRAME_BYTES], uint8_t display[FZMV_FRAME_BYTES]);

bool fzmv_read_tone(File* file, const FzmvInfo* info, uint32_t index, FzmvTone* tone);
bool fzmv_decode_pcm_block(
    File* file, const FzmvInfo* info, uint32_t block_index,
    int16_t samples[FZMV_PCM_BLOCK_SAMPLES]);
