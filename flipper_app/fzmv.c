#include "fzmv.h"

#include <string.h>

static uint16_t read_u16(const uint8_t* data) {
    return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

static uint32_t read_u32(const uint8_t* data) {
    return (uint32_t)data[0] | ((uint32_t)data[1] << 8) |
           ((uint32_t)data[2] << 16) | ((uint32_t)data[3] << 24);
}

static bool read_exact(File* file, uint32_t offset, void* buffer, size_t size) {
    return storage_file_seek(file, offset, true) && storage_file_read(file, buffer, size) == size;
}

bool fzmv_open(File* file, FzmvInfo* info, const char** error) {
    uint8_t header[64];
    const uint64_t actual_size = storage_file_size(file);
    if(actual_size < sizeof(header) || actual_size > UINT32_MAX ||
       !read_exact(file, 0, header, sizeof(header))) {
        *error = "File is too large or unreadable";
        return false;
    }
    if(memcmp(header, "FZMV", 4) != 0) {
        *error = "Invalid FZMV signature";
        return false;
    }
    const uint16_t version = read_u16(header + 4);
    if((version != 1 && version != 2) || read_u16(header + 6) != 64 ||
       read_u16(header + 8) != FZMV_WIDTH || read_u16(header + 10) != FZMV_HEIGHT ||
       read_u16(header + 14) != (version == 1 ? 20 : 0) ||
       read_u32(header + 44) != actual_size) {
        *error = "Unsupported FZMV header";
        return false;
    }

    info->version = version;
    info->fps = read_u16(header + 12);
    info->frame_count = read_u32(header + 16);
    info->tick_count = read_u32(header + 20);
    info->frame_index_offset = read_u32(header + 24);
    info->frame_data_offset = read_u32(header + 28);
    info->audio_offset = read_u32(header + 32);
    info->duration_ms = read_u32(header + 36);
    info->file_size = (uint32_t)actual_size;
    info->sample_count = 0;

    const uint32_t flags = read_u32(header + 40);
    const uint64_t video_end = (uint64_t)info->frame_index_offset + info->frame_count * 4ull;
    if(info->fps < 1 || info->fps > 60 || info->frame_count == 0 ||
       info->frame_index_offset < 64 || video_end > info->frame_data_offset ||
       info->frame_data_offset > info->audio_offset || info->audio_offset > actual_size ||
       (uint64_t)info->frame_count * 3u > info->audio_offset - info->frame_data_offset ||
       info->duration_ms == 0) {
        *error = "Damaged frame index or offsets";
        return false;
    }

    if(version == 1) {
        if(flags != (info->tick_count ? 1u : 0u) ||
           (uint64_t)info->audio_offset + info->tick_count * 4ull != actual_size) {
            *error = "Damaged tone stream";
            return false;
        }
    } else {
        info->sample_count = read_u32(header + 52);
        const uint64_t blocks = ((uint64_t)info->sample_count + 255u) / 256u;
        if(flags != 2 || info->tick_count != 0 || read_u32(header + 48) != 16000 ||
           info->sample_count == 0 || read_u16(header + 56) != 1 ||
           read_u16(header + 58) != 256 || read_u16(header + 60) != 132 ||
           read_u16(header + 62) != 0 ||
           (uint64_t)info->audio_offset + blocks * 132u != actual_size) {
            *error = "Damaged or unsupported ADPCM";
            return false;
        }
    }
    return true;
}

static bool frame_record(
    File* file, const FzmvInfo* info, uint32_t index,
    uint8_t frame[FZMV_FRAME_BYTES], bool* is_delta) {
    uint8_t offset_bytes[4];
    if(!read_exact(file, info->frame_index_offset + 4u * index, offset_bytes, 4)) return false;
    const uint32_t offset = read_u32(offset_bytes);
    if(offset < info->frame_data_offset || (uint64_t)offset + 3u > info->audio_offset) return false;
    uint8_t record[3];
    if(!read_exact(file, offset, record, 3)) return false;
    const uint8_t mode = record[0];
    const uint16_t size = read_u16(record + 1);
    if(mode > 3 || size == 0 || size > FZMV_FRAME_BYTES ||
       (uint64_t)offset + 3u + size > info->audio_offset) return false;

    uint8_t payload[FZMV_FRAME_BYTES];
    if(!read_exact(file, offset + 3u, payload, size)) return false;

    if((mode & 1u) == 0) {
        if(size != FZMV_FRAME_BYTES) return false;
        memcpy(frame, payload, FZMV_FRAME_BYTES);
    } else {
        size_t src = 0;
        size_t dst = 0;
        while(src < size) {
            const uint8_t instruction = payload[src++];
            const size_t count = (instruction & 0x7fu) + 1u;
            if(dst + count > FZMV_FRAME_BYTES) return false;
            if(instruction & 0x80u) {
                if(src >= size) return false;
                memset(frame + dst, payload[src++], count);
            } else {
                if(src + count > size) return false;
                memcpy(frame + dst, payload + src, count);
                src += count;
            }
            dst += count;
        }
        if(dst != FZMV_FRAME_BYTES) return false;
    }
    *is_delta = (mode & 2u) != 0;
    return true;
}

bool fzmv_frame_at(
    File* file, const FzmvInfo* info, uint32_t index,
    uint32_t previous_index, uint8_t previous_frame[FZMV_FRAME_BYTES],
    const char** error) {
    if(index >= info->frame_count) {
        *error = "Frame outside file";
        return false;
    }
    if(index == previous_index) return true;

    uint32_t first = index;
    if(previous_index != UINT32_MAX && previous_index + 1u == index) {
        first = index;
    } else {
        /* At most two seconds of frames between keyframes in the web encoder. */
        const uint32_t limit = info->fps * 2u + 1u;
        bool found = false;
        for(uint32_t count = 0; count < limit && first < info->frame_count; count++) {
            uint8_t offset_bytes[4];
            uint8_t mode;
            if(!read_exact(file, info->frame_index_offset + 4u * first, offset_bytes, 4)) break;
            const uint32_t pos = read_u32(offset_bytes);
            if(pos < info->frame_data_offset || pos >= info->audio_offset ||
               !read_exact(file, pos, &mode, 1) || mode > 3) break;
            if(mode < 2) { found = true; break; }
            if(first == 0) break;
            first--;
        }
        if(!found) {
            *error = "Missing nearby keyframe";
            return false;
        }
    }

    uint8_t decoded[FZMV_FRAME_BYTES];
    for(uint32_t current = first; current <= index; current++) {
        bool delta = false;
        if(!frame_record(file, info, current, decoded, &delta)) {
            *error = "Damaged frame data";
            return false;
        }
        if(delta) {
            if(current == first && (previous_index == UINT32_MAX || previous_index + 1u != first)) {
                *error = "Delta frame without reference";
                return false;
            }
            for(size_t i = 0; i < FZMV_FRAME_BYTES; i++) decoded[i] ^= previous_frame[i];
        }
        memcpy(previous_frame, decoded, FZMV_FRAME_BYTES);
    }
    return true;
}

void fzmv_to_display(const uint8_t frame[FZMV_FRAME_BYTES], uint8_t display[FZMV_FRAME_BYTES]) {
    for(uint32_t page = 0; page < 8; page++) {
        for(uint32_t x = 0; x < FZMV_WIDTH; x++) {
            uint8_t vertical = 0;
            for(uint32_t bit = 0; bit < 8; bit++) {
                const uint32_t y = page * 8u + bit;
                const uint8_t pixel = frame[y * 16u + (x >> 3u)];
                if(pixel & (0x80u >> (x & 7u))) vertical |= 1u << bit;
            }
            display[page * FZMV_WIDTH + x] = vertical;
        }
    }
}

bool fzmv_read_tone(File* file, const FzmvInfo* info, uint32_t index, FzmvTone* tone) {
    if(info->version != 1 || index >= info->tick_count) return false;
    uint8_t data[4];
    if(!read_exact(file, info->audio_offset + index * 4u, data, 4)) return false;
    tone->frequency = read_u16(data);
    tone->gain = data[2];
    tone->gate = data[3];
    return true;
}

static const uint16_t step_table[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
    34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
    157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
    598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
    1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
    5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};
static const int8_t index_delta[8] = {-1, -1, -1, -1, 2, 4, 6, 8};

bool fzmv_decode_pcm_block(
    File* file, const FzmvInfo* info, uint32_t block_index,
    int16_t samples[FZMV_PCM_BLOCK_SAMPLES]) {
    if(info->version != 2 || block_index >= ((uint64_t)info->sample_count + 255u) / 256u)
        return false;
    const uint64_t location = (uint64_t)info->audio_offset + (uint64_t)block_index * 132u;
    if(location + 132u > info->file_size) return false;
    uint8_t data[FZMV_PCM_BLOCK_BYTES];
    if(!read_exact(file, (uint32_t)location, data, sizeof(data))) return false;
    int32_t predictor = (int16_t)read_u16(data);
    int32_t index = data[2];
    if(index > 88 || data[3] != 0) return false;
    samples[0] = (int16_t)predictor;

    for(size_t i = 1; i < FZMV_PCM_BLOCK_SAMPLES; i++) {
        const uint8_t packed = data[4u + ((i - 1u) >> 1u)];
        const uint8_t nibble = i & 1u ? packed & 0x0fu : packed >> 4u;
        const int32_t step = step_table[index];
        const int32_t diff = (step >> 3) + ((nibble & 1u) ? (step >> 2) : 0) +
                             ((nibble & 2u) ? (step >> 1) : 0) +
                             ((nibble & 4u) ? step : 0);
        predictor += nibble & 8u ? -diff : diff;
        if(predictor > 32767) predictor = 32767;
        if(predictor < -32768) predictor = -32768;
        index += index_delta[nibble & 7u];
        if(index < 0) index = 0;
        if(index > 88) index = 88;
        samples[i] = (int16_t)predictor;
    }
    return true;
}
