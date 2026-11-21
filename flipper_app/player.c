#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <dialogs/dialogs.h>
#include <gui/modules/text_input.h>
#include <gui/view_holder.h>
#include <storage/storage.h>
#include <stdio.h>
#include <string.h>

#include "fzmv.h"
#include "audio_pwm.h"

#define SEEK_MS 5000u
#define PLAYER_FOLDER "/ext/fzmv"

typedef struct {
    ViewPort* viewport;
    FuriMutex* draw_mutex;
    FuriMessageQueue* events;
    uint8_t video[FZMV_FRAME_BYTES];
    uint8_t display[FZMV_FRAME_BYTES];
    uint32_t decoded_frame;
    uint32_t position_ms;
    uint32_t duration_ms;
    uint8_t volume;
    bool tracker;
    uint16_t frequency;
    uint8_t gain;
    bool paused;
    bool loaded;
    const char* error;
    const char* rename_status;
} PlayerUi;

static void player_draw(Canvas* canvas, void* context) {
    PlayerUi* ui = context;
    canvas_clear(canvas);
    if(!ui->loaded) {
        canvas_set_font(canvas, FontPrimary);
        canvas_draw_str(canvas, 4, 13, "FZMV Player");
        canvas_set_font(canvas, FontSecondary);
        canvas_draw_str(canvas, 4, 31, ui->error ? ui->error : "Choose .fzmv file");
        canvas_draw_str(canvas, 4, 58, "Back: exit");
        return;
    }
    if(ui->tracker) {
        canvas_set_font(canvas, FontSecondary);
        canvas_draw_str(canvas, 5, 9, "FZMV / TRACKER");
        canvas_draw_line(canvas, 5, 13, 123, 13);
        char frequency[32];
        snprintf(frequency, sizeof(frequency), "%u Hz", ui->frequency);
        canvas_set_font(canvas, FontPrimary);
        canvas_draw_str(canvas, 5, 30, ui->frequency ? frequency : "REST");
        const uint16_t hz = ui->frequency;
        /* Semitone bins are used for an inexpensive note display on-device. */
        static const uint16_t notes[] = {262,277,294,311,330,349,370,392,415,440,466,494};
        static const char* names[] = {"C","C#","D","D#","E","F","F#","G","G#","A","A#","B"};
        if(hz) {
            uint32_t normalized = hz;
            int octave = 4;
            while(normalized >= 524 && octave < 8) { normalized = (normalized + 1) / 2; octave++; }
            while(normalized < 262 && octave > 0) { normalized *= 2; octave--; }
            int nearest = 0;
            uint32_t delta = UINT32_MAX;
            for(int n = 0; n < 12; n++) {
                uint32_t diff = normalized > notes[n] ? normalized - notes[n] : notes[n] - normalized;
                if(diff < delta) { delta = diff; nearest = n; }
            }
            char label[14];
            snprintf(label, sizeof(label), "%s%d", names[nearest], octave);
            canvas_draw_str(canvas, 91, 30, label);
        }
        canvas_draw_frame(canvas, 5, 39, 118, 9);
        canvas_draw_box(canvas, 6, 40, (uint8_t)((uint32_t)ui->gain * 116 / 255), 7);
        canvas_set_font(canvas, FontSecondary);
        canvas_draw_str(canvas, 5, 62, ui->paused ? "OK Play  Long Down: View" : "8BIT / MONO");
    } else {
        furi_mutex_acquire(ui->draw_mutex, FuriWaitForever);
        memcpy(canvas_get_buffer(canvas), ui->display, FZMV_FRAME_BYTES);
        furi_mutex_release(ui->draw_mutex);
    }
    if(ui->paused) {
        canvas_set_color(canvas, ColorWhite);
        canvas_draw_box(canvas, 0, 42, 128, 22);
        canvas_set_color(canvas, ColorBlack);
        canvas_set_font(canvas, FontSecondary);
        char status[40];
        snprintf(status, sizeof(status), "PAUSE %lu/%lus Vol%u",
                 (unsigned long)(ui->position_ms / 1000u),
                 (unsigned long)(ui->duration_ms / 1000u), ui->volume);
        canvas_draw_str(canvas, 2, 51, status);
        canvas_draw_str(canvas, 2, 62, ui->rename_status ? ui->rename_status : "Long Down: View  OK: Rename");
    }
}

static void player_input(InputEvent* input, void* context) {
    PlayerUi* ui = context;
    if(input->type != InputTypeShort && input->type != InputTypeRepeat &&
       input->type != InputTypeLong) return;
    uint8_t event = (input->type == InputTypeLong ? 0x40u : 0x80u) |
                    (uint8_t)input->key;
    furi_message_queue_put(ui->events, &event, 0);
}

static void rename_done(void* context) {
    PlayerUi* ui = context;
    uint8_t event = 1;
    furi_message_queue_put(ui->events, &event, 0);
}

static void rename_cancel(void* context) {
    PlayerUi* ui = context;
    uint8_t event = 2;
    furi_message_queue_put(ui->events, &event, 0);
}

/* File is closed by the caller. Keep the directory and .fzmv extension;
 * reject invalid paths and never overwrite another file. */
static bool player_rename(Gui* gui, Storage* storage, PlayerUi* ui, FuriString* path) {
    char name[64] = {0};
    const char* old_path = furi_string_get_cstr(path);
    const char* slash = strrchr(old_path, '/');
    const char* base = slash ? slash + 1 : old_path;
    size_t base_len = strlen(base);
    if(base_len < 6 || strcmp(base + base_len - 5, ".fzmv") != 0) return false;
    size_t stem_len = base_len - 5;
    if(stem_len >= sizeof(name)) stem_len = sizeof(name) - 1;
    bool ascii = true;
    for(size_t i = 0; i < stem_len; i++) {
        if((uint8_t)base[i] < 32 || (uint8_t)base[i] > 126) ascii = false;
    }
    if(ascii) memcpy(name, base, stem_len);
    else strlcpy(name, "video", sizeof(name));

    TextInput* input = text_input_alloc();
    ViewHolder* holder = view_holder_alloc();
    text_input_set_header_text(input, "New file name:");
    text_input_set_minimum_length(input, 1);
    text_input_set_result_callback(input, rename_done, ui, name, sizeof(name), false);
    view_holder_attach_to_gui(holder, gui);
    view_holder_set_back_callback(holder, rename_cancel, ui);
    view_holder_set_view(holder, text_input_get_view(input));
    view_holder_send_to_front(holder);

    bool accepted = false;
    uint8_t event = 0;
    while(furi_message_queue_get(ui->events, &event, FuriWaitForever) == FuriStatusOk) {
        if(event == 1) { accepted = true; break; }
        if(event == 2) break;
    }
    view_holder_set_view(holder, NULL);
    view_holder_free(holder);
    text_input_free(input);

    if(!accepted || !name[0] || strchr(name, '/') || strchr(name, '\\') ||
       strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return false;

    FuriString* destination = furi_string_alloc();
    furi_string_printf(destination, "%.*s%s.fzmv", (int)(base - old_path), old_path, name);
    const char* target = furi_string_get_cstr(destination);
    bool success = strcmp(old_path, target) == 0;
    if(!success && !storage_common_exists(storage, target)) {
        success = storage_common_rename(storage, old_path, target) == FSE_OK;
    }
    if(success) furi_string_set(path, target);
    furi_string_free(destination);
    return success;
}

static uint32_t clamp_seek(uint32_t current, uint32_t duration, bool forward) {
    if(forward) return current >= duration - MIN(duration, SEEK_MS) ? duration - 1u : current + SEEK_MS;
    return current < SEEK_MS ? 0 : current - SEEK_MS;
}

static bool player_frame(File* file, const FzmvInfo* info, PlayerUi* ui, uint32_t ms) {
    uint32_t frame = (uint32_t)MIN((uint64_t)info->frame_count - 1,
                                  ((uint64_t)ms * info->fps) / 1000u);
    if(frame == ui->decoded_frame) return true;
    const char* error = NULL;
    if(!fzmv_frame_at(file, info, frame, ui->decoded_frame, ui->video, &error)) {
        ui->error = error;
        return false;
    }
    uint8_t display[FZMV_FRAME_BYTES];
    fzmv_to_display(ui->video, display);
    furi_mutex_acquire(ui->draw_mutex, FuriWaitForever);
    memcpy(ui->display, display, sizeof(display));
    furi_mutex_release(ui->draw_mutex);
    ui->decoded_frame = frame;
    view_port_update(ui->viewport);
    return true;
}

static bool player_choose_file(FuriString* path) {
    DialogsApp* dialogs = furi_record_open(RECORD_DIALOGS);
    DialogsFileBrowserOptions options;
    dialog_file_browser_set_basic_options(&options, ".fzmv", NULL);
    options.base_path = "/ext";
    options.hide_ext = false;
    furi_string_set(path, PLAYER_FOLDER);
    bool selected = dialog_file_browser_show(dialogs, path, path, &options);
    furi_record_close(RECORD_DIALOGS);
    return selected;
}

static void player_tone(File* file, const FzmvInfo* info, uint32_t ms,
                        uint8_t volume, bool* active, uint32_t* previous_tick) {
    uint32_t tick = ms / 20u;
    FzmvTone tone = {0};
    if(tick >= info->tick_count || !fzmv_read_tone(file, info, tick, &tone)) {
        if(*active) furi_hal_speaker_stop();
        *active = false;
        *previous_tick = UINT32_MAX;
        return;
    }
    bool on = tone.frequency >= 20 && tone.frequency <= 2500 &&
              ((ms % 20u) * 100u < (uint32_t)tone.gate * 20u) && tone.gain && volume;
    if(on && (tick != *previous_tick || !*active)) {
        float level = (float)tone.gain / 255.0f * (float)volume / 100.0f;
        furi_hal_speaker_start((float)tone.frequency, level);
        *active = true;
    } else if(!on && *active) {
        furi_hal_speaker_stop();
        *active = false;
    }
    *previous_tick = tick;
}

int32_t fzmv_player_app(void* arg) {
    UNUSED(arg);
    PlayerUi* ui = malloc(sizeof(PlayerUi));
    memset(ui, 0, sizeof(*ui));
    ui->volume = 100;
    ui->decoded_frame = UINT32_MAX;
    ui->draw_mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    ui->events = furi_message_queue_alloc(32, sizeof(uint8_t));
    ui->viewport = view_port_alloc();
    view_port_draw_callback_set(ui->viewport, player_draw, ui);
    view_port_input_callback_set(ui->viewport, player_input, ui);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, ui->viewport, GuiLayerFullscreen);

    Storage* storage = furi_record_open(RECORD_STORAGE);
    FuriString* path = furi_string_alloc();
    File* file = storage_file_alloc(storage);
    FzmvInfo info = {0};
    bool opened = false;
    bool running = false;
    bool tone_acquired = false;
    bool tone_active = false;
    uint32_t previous_tick = UINT32_MAX;
    AudioPwm* audio = malloc(sizeof(AudioPwm));
    memset(audio, 0, sizeof(*audio));

    if(!player_choose_file(path)) goto done;
    if(!storage_file_open(file, furi_string_get_cstr(path), FSAM_READ, FSOM_OPEN_EXISTING)) {
        ui->error = "Cannot open SD file";
        goto done;
    }
    opened = true;
    if(!fzmv_open(file, &info, &ui->error)) goto done;
    ui->duration_ms = info.duration_ms;
    ui->tracker = info.playback_mode == 2;
    ui->loaded = true;
    if(!ui->tracker && !player_frame(file, &info, ui, 0)) goto done;

    uint32_t anchor_ms = 0;
    uint32_t anchor_tick = furi_get_tick();
    const uint32_t ticks_per_second = furi_kernel_get_tick_frequency();
    bool use_audio_clock = false;
    if(info.pcm_audio) {
        use_audio_clock = audio_pwm_start(audio, file, &info, 0, ui->volume, ui->events);
    } else if(info.tick_count) {
        tone_acquired = furi_hal_speaker_acquire(100);
    }
    running = true;

    while(running) {
        uint8_t event = 0;
        const FuriStatus received = furi_message_queue_get(ui->events, &event, 8);
        if(received == FuriStatusOk && event == (0x40u | InputKeyDown) &&
           !info.pcm_audio) {
            ui->tracker = !ui->tracker;
            if(!ui->tracker) player_frame(file, &info, ui, ui->position_ms);
            view_port_update(ui->viewport);
            continue;
        }
        if(received == FuriStatusOk && event == (0x40u | InputKeyOk)) {
            if(use_audio_clock) {
                audio_pwm_stop(audio);
                use_audio_clock = false;
            }
            if(tone_acquired && tone_active) furi_hal_speaker_stop();
            tone_active = false;
            ui->paused = true;
            anchor_ms = ui->position_ms;
            storage_file_close(file);
            opened = false;
            /* Discard pending PWM wakeups before waiting for the text input result. */
            uint8_t pending_event;
            while(furi_message_queue_get(ui->events, &pending_event, 0) == FuriStatusOk) {}
            bool renamed = player_rename(gui, storage, ui, path);
            ui->rename_status = renamed ? "Renamed" : "Rename cancelled/failed";
            if(!storage_file_open(file, furi_string_get_cstr(path), FSAM_READ, FSOM_OPEN_EXISTING)) {
                ui->error = "Cannot reopen file";
                break;
            }
            opened = true;
            view_port_update(ui->viewport);
            continue;
        }
        if(received == FuriStatusOk && (event & 0x80u)) {
            InputKey key = (InputKey)(event & 0x7fu);
            if(key == InputKeyBack) break;
            if(key == InputKeyOk) {
                ui->rename_status = NULL;
                if(!ui->paused) {
                    if(use_audio_clock) audio_pwm_stop(audio);
                    if(tone_acquired && tone_active) furi_hal_speaker_stop();
                    tone_active = false;
                    anchor_ms = ui->position_ms;
                    ui->paused = true;
                } else {
                    if(ui->position_ms >= info.duration_ms - 1u) {
                        anchor_ms = 0;
                        ui->position_ms = 0;
                        previous_tick = UINT32_MAX;
                        if(!ui->tracker) player_frame(file, &info, ui, 0);
                    }
                    anchor_tick = furi_get_tick();
                    if(info.pcm_audio) {
                        use_audio_clock = audio_pwm_start(audio, file, &info,
                            (uint32_t)((uint64_t)anchor_ms * FZMV_PCM_RATE / 1000u),
                            ui->volume, ui->events);
                    }
                    ui->paused = false;
                }
                view_port_update(ui->viewport);
            } else if(key == InputKeyLeft || key == InputKeyRight) {
                anchor_ms = clamp_seek(ui->position_ms, info.duration_ms, key == InputKeyRight);
                anchor_tick = furi_get_tick();
                ui->position_ms = anchor_ms;
                if(info.pcm_audio && use_audio_clock && !ui->paused) {
                    audio_pwm_stop(audio);
                    use_audio_clock = audio_pwm_start(audio, file, &info,
                        (uint32_t)((uint64_t)anchor_ms * FZMV_PCM_RATE / 1000u),
                        ui->volume, ui->events);
                }
                if(!info.pcm_audio && tone_active) {
                    furi_hal_speaker_stop();
                    tone_active = false;
                }
                previous_tick = UINT32_MAX;
                if(!ui->tracker) player_frame(file, &info, ui, anchor_ms);
            } else if(key == InputKeyUp || key == InputKeyDown) {
                ui->volume = (uint8_t)(key == InputKeyUp ? MIN(100u, ui->volume + 10u) :
                                                       (ui->volume >= 10u ? ui->volume - 10u : 0u));
                if(use_audio_clock) audio->volume = ui->volume;
                if(ui->paused) view_port_update(ui->viewport);
            }
        }
        if(ui->paused) continue;

        if(use_audio_clock) {
            audio_pwm_refill(audio, file, &info);
            uint32_t sample = audio_pwm_position(audio);
            ui->position_ms = (uint32_t)MIN((uint64_t)info.duration_ms,
                                            (uint64_t)sample * 1000u / FZMV_PCM_RATE);
        } else {
            uint32_t elapsed = furi_get_tick() - anchor_tick;
            ui->position_ms = (uint32_t)MIN((uint64_t)info.duration_ms,
                (uint64_t)anchor_ms + (uint64_t)elapsed * 1000u / ticks_per_second);
        }
        if(ui->position_ms >= info.duration_ms) {
            if(use_audio_clock) audio_pwm_stop(audio);
            if(tone_acquired && tone_active) furi_hal_speaker_stop();
            tone_active = false;
            ui->paused = true;
            ui->position_ms = info.duration_ms - 1u;
            anchor_ms = ui->position_ms;
            view_port_update(ui->viewport);
            continue;
        }
        if(!info.pcm_audio && tone_acquired) {
            player_tone(file, &info, ui->position_ms, ui->volume, &tone_active, &previous_tick);
        }
        if(ui->tracker) {
            FzmvTone current = {0};
            if(fzmv_read_tone(file, &info, ui->position_ms / 20u, &current)) {
                ui->frequency = current.frequency;
                ui->gain = current.gain;
            } else {
                ui->frequency = 0;
                ui->gain = 0;
            }
            view_port_update(ui->viewport);
        } else if(!player_frame(file, &info, ui, ui->position_ms)) break;
    }

done:
    if(audio->running) audio_pwm_stop(audio);
    if(tone_acquired) {
        if(tone_active) furi_hal_speaker_stop();
        furi_hal_speaker_release();
    }
    if(ui->error) {
        ui->loaded = false;
        view_port_update(ui->viewport);
        furi_delay_ms(1600);
    }
    free(audio);
    if(opened) storage_file_close(file);
    storage_file_free(file);
    furi_string_free(path);
    furi_record_close(RECORD_STORAGE);
    gui_remove_view_port(gui, ui->viewport);
    furi_record_close(RECORD_GUI);
    view_port_free(ui->viewport);
    furi_message_queue_free(ui->events);
    furi_mutex_free(ui->draw_mutex);
    free(ui);
    return 0;
}
