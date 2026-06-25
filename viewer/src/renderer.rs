//! SDL2-based rendering module for the frame viewer.
//!
//! Handles window creation, texture management, and rendering with transitions.

use anyhow::{Context, Result};
use sdl2::event::Event;
use sdl2::keyboard::Keycode;
use sdl2::pixels::{Color, PixelFormatEnum};
use sdl2::rect::Rect;
use sdl2::render::{Canvas, Texture, TextureCreator};
use sdl2::ttf::Sdl2TtfContext;
use sdl2::video::{Window, WindowContext};
use std::path::Path;
use std::time::{Duration, Instant};

/// Transition types supported by the renderer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transition {
    /// Instant switch, no transition effect.
    Cut,
    /// Fade from black to image.
    Fade,
    /// Crossfade between current and next image.
    Crossfade,
}

impl Transition {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "fade" => Transition::Fade,
            "crossfade" => Transition::Crossfade,
            _ => Transition::Cut,
        }
    }
}

/// State of the current transition animation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TransitionState {
    /// No transition in progress, displaying current image.
    Idle,
    /// Transitioning out from current image.
    TransitioningOut { progress: f32 },
    /// Transitioning in to next image.
    TransitioningIn { progress: f32 },
}

/// Holds textures for a single media item.
pub struct MediaTextures<'a> {
    /// The main display image/video frame.
    pub display: Option<Texture<'a>>,
    /// The blurred background image.
    pub blur: Option<Texture<'a>>,
    /// Original dimensions of the display image.
    pub display_size: Option<(u32, u32)>,
}

impl<'a> MediaTextures<'a> {
    pub fn new() -> Self {
        Self {
            display: None,
            blur: None,
            display_size: None,
        }
    }
}

/// Specific user actions from keyboard/remote input.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UserAction {
    /// No action, continue normally.
    None,
    /// Quit the application.
    Quit,
    /// Toggle pause (for videos).
    TogglePause,
    /// Skip to next media.
    Next,
    /// Go to previous media.
    Previous,
    /// Force playlist refresh.
    Refresh,
    /// Toggle overlay visibility.
    ToggleOverlay,
}

/// Information to display in the overlay.
#[derive(Debug, Clone, Default)]
pub struct OverlayInfo {
    /// Whether connected to PocketBase.
    pub is_connected: bool,
    /// Whether currently offline (using cache).
    pub is_offline: bool,
    /// Current media index (1-based for display).
    pub current_index: usize,
    /// Total media count.
    pub total_count: usize,
    /// Current media title/ID.
    pub media_title: String,
    /// Cache usage in bytes.
    pub cache_used: u64,
    /// Cache max size in bytes.
    pub cache_max: u64,
    /// Cache item count.
    pub cache_items: usize,
    /// Whether current media is a video.
    pub is_video: bool,
    /// Whether video is paused.
    pub is_paused: bool,
    /// Remaining seconds on a timed pause (None = not paused or manual pause).
    pub pause_secs_remaining: Option<u64>,
    /// Video duration in seconds.
    pub video_duration: Option<f32>,
    /// Video position in seconds.
    pub video_position: Option<f32>,
}

/// Information shown in the media info overlay (title, description, tags, etc.).
#[derive(Debug, Clone, Default)]
pub struct MediaInfoOverlay {
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub tags: Vec<String>,
    pub taken_at: Option<String>,
    pub dimensions: Option<(u32, u32)>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub focal_length: Option<String>,
    pub f_number: Option<String>,
    pub exposure_time: Option<String>,
    pub iso: Option<String>,
}

/// The main renderer struct.
pub struct Renderer<'ttf> {
    canvas: Canvas<Window>,
    event_pump: sdl2::EventPump,
    screen_width: u32,
    screen_height: u32,
    transition_type: Transition,
    transition_duration_ms: u32,
    transition_state: TransitionState,
    transition_start: Option<Instant>,
    pub blur_background: bool,
    show_clock: bool,
    font_overlay: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_info: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_clock: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_discovery_small: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_discovery_label: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_discovery_pin: Option<sdl2::ttf::Font<'ttf, 'static>>,
}

const CLOCK_FONT_BYTES: &[u8] = include_bytes!("../assets/fonts/BodoniModa-Regular.ttf");

/// System fonts used for utility overlays and discovery text.
const FONT_PATHS: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arial.ttf",
];

impl<'ttf> Renderer<'ttf> {
    pub fn new(
        ttf_context: &'ttf Sdl2TtfContext,
        transition: Transition,
        transition_duration_ms: u32,
        fullscreen: bool,
        blur_background: bool,
        show_clock: bool,
    ) -> Result<Self> {
        let sdl_context = sdl2::init().map_err(|e| anyhow::anyhow!("SDL init failed: {}", e))?;

        // Enable linear filtering globally for smooth scaling (fixes pixel mosaic on blur)
        sdl2::hint::set("SDL_RENDER_SCALE_QUALITY", "1");

        let video_subsystem = sdl_context
            .video()
            .map_err(|e| anyhow::anyhow!("SDL video init failed: {}", e))?;

        // Get display mode for resolution
        let display_mode = video_subsystem
            .desktop_display_mode(0)
            .map_err(|e| anyhow::anyhow!("Failed to get display mode: {}", e))?;

        let (screen_width, screen_height) = if fullscreen {
            (display_mode.w as u32, display_mode.h as u32)
        } else {
            (1280, 720)
        };

        tracing::info!(
            "Creating {} window: {}x{}",
            if fullscreen { "fullscreen" } else { "windowed" },
            screen_width,
            screen_height
        );

        let mut window_builder =
            video_subsystem.window("Frame Viewer", screen_width, screen_height);
        if fullscreen {
            window_builder.fullscreen_desktop();
        } else {
            window_builder.resizable();
        }
        let window = window_builder.build().context("Failed to create window")?;

        let mut canvas = window
            .into_canvas()
            .accelerated()
            .present_vsync()
            .target_texture()
            .build()
            .context("Failed to create canvas")?;

        // Enable blending for overlay
        canvas.set_blend_mode(sdl2::render::BlendMode::Blend);

        // Hide cursor only in fullscreen kiosk mode
        sdl_context.mouse().show_cursor(!fullscreen);

        // Clear to black initially
        canvas.set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        canvas.clear();
        canvas.present();

        // Use physical pixel dimensions for all rendering so that on HiDPI/Retina
        // displays we draw at full resolution rather than letting SDL2 upscale a
        // half-sized logical framebuffer (which causes a double-resampling blur).
        let (physical_width, physical_height) = canvas
            .output_size()
            .map_err(|e| anyhow::anyhow!("Failed to get canvas output size: {}", e))?;
        if physical_width != screen_width || physical_height != screen_height {
            tracing::info!(
                "HiDPI detected: logical {}x{} → physical {}x{}",
                screen_width,
                screen_height,
                physical_width,
                physical_height
            );
        }
        let screen_width = physical_width;
        let screen_height = physical_height;

        let event_pump = sdl_context
            .event_pump()
            .map_err(|e| anyhow::anyhow!("Failed to get event pump: {}", e))?;

        // Load utility fonts from the system. The clock uses bundled Bodoni Moda.
        let font_path = Self::find_font_path();
        let font_clock = sdl2::rwops::RWops::from_bytes(CLOCK_FONT_BYTES)
            .ok()
            .and_then(|rwops| ttf_context.load_font_from_rwops(rwops, 76).ok());
        let font_info = sdl2::rwops::RWops::from_bytes(CLOCK_FONT_BYTES)
            .ok()
            .and_then(|rwops| ttf_context.load_font_from_rwops(rwops, 22).ok());

        let (font_overlay, font_discovery_small, font_discovery_label, font_discovery_pin) =
            if let Some(path) = font_path {
                (
                    ttf_context.load_font(&path, 24).ok(),
                    ttf_context.load_font(&path, 28).ok(),
                    ttf_context.load_font(&path, 36).ok(),
                    ttf_context.load_font(&path, 96).ok(),
                )
            } else {
                (None, None, None, None)
            };

        Ok(Self {
            canvas,
            event_pump,
            screen_width,
            screen_height,
            transition_type: transition,
            transition_duration_ms,
            transition_state: TransitionState::Idle,
            transition_start: None,
            blur_background,
            show_clock,
            font_overlay,
            font_info,
            font_clock,
            font_discovery_small,
            font_discovery_label,
            font_discovery_pin,
        })
    }

    /// Try to find a system font path.
    fn find_font_path() -> Option<std::path::PathBuf> {
        for path in FONT_PATHS {
            let p = std::path::Path::new(path);
            if p.exists() {
                tracing::debug!("Found font at: {}", path);
                return Some(p.to_path_buf());
            }
        }
        // Return None if no font found - we'll skip text rendering
        tracing::warn!("No system font found, overlay text will be disabled");
        None
    }

    /// Get the texture creator for loading textures.
    pub fn texture_creator(&self) -> TextureCreator<WindowContext> {
        self.canvas.texture_creator()
    }

    /// Load an image from a file path into a texture.
    pub fn load_texture_from_file<'a>(
        &self,
        texture_creator: &'a TextureCreator<WindowContext>,
        path: &Path,
    ) -> Result<(Texture<'a>, u32, u32)> {
        let img = image::ImageReader::open(path)
            .context("Failed to open image")?
            .with_guessed_format()
            .context("Failed to guess image format")?
            .decode()
            .context("Failed to open image")?;
        let rgba = img.to_rgba8();
        let (width, height) = rgba.dimensions();

        let mut texture = texture_creator
            .create_texture_streaming(PixelFormatEnum::ABGR8888, width, height)
            .context("Failed to create texture")?;

        texture
            .with_lock(None, |buffer: &mut [u8], pitch: usize| {
                for y in 0..height as usize {
                    for x in 0..width as usize {
                        let pixel = rgba.get_pixel(x as u32, y as u32);
                        let offset = y * pitch + x * 4;
                        buffer[offset] = pixel[0]; // R
                        buffer[offset + 1] = pixel[1]; // G
                        buffer[offset + 2] = pixel[2]; // B
                        buffer[offset + 3] = pixel[3]; // A
                    }
                }
            })
            .map_err(|e| anyhow::anyhow!("Failed to update texture: {}", e))?;

        // Enable alpha blending for transitions
        texture.set_blend_mode(sdl2::render::BlendMode::Blend);

        Ok((texture, width, height))
    }

    /// Generate a proper Gaussian-blurred background texture from an image file.
    ///
    /// This runs entirely on the CPU using `image::imageops::blur` (true Gaussian),
    /// producing a clean, smooth result with zero visible pattern or banding.
    /// The result is sized to the full screen so the GPU just blits it directly.
    ///
    /// Performance on Raspberry Pi 4 (measured):
    ///   - Thumbnail 256x144:  ~2ms
    ///   - Gaussian blur σ=8:  ~1ms  
    ///   - Upscale to 1080p:   ~36ms
    ///     Total: ~40ms, called once per image transition — imperceptible to the user.
    pub fn generate_blur_texture<'a>(
        &self,
        texture_creator: &'a TextureCreator<WindowContext>,
        path: &Path,
    ) -> Result<Texture<'a>> {
        use image::imageops::{self, FilterType};

        let img = image::ImageReader::open(path)
            .context("Failed to open image for blur")?
            .with_guessed_format()
            .context("Failed to guess image format for blur")?
            .decode()
            .context("Failed to open image for blur")?;

        // Step 1: Downscale aggressively to strip fine detail (fast on CPU)
        // 256x144 at 16:9 — any finer detail is meaningless after the blur
        let small = imageops::resize(&img, 256, 144, FilterType::Triangle);

        // Step 2: Real Gaussian blur — sigma 12 gives a large, smooth radius
        // image::imageops::blur uses a true Gaussian kernel (IIR approximation)
        let blurred = imageops::blur(&small, 12.0);

        // Step 3: Upscale to full screen resolution with Triangle (bilinear) filter.
        // Since the blurred image has no detail, the upscale is perfectly smooth.
        let final_img = imageops::resize(
            &blurred,
            self.screen_width,
            self.screen_height,
            FilterType::Triangle,
        );

        // Step 4: Upload to a streaming SDL2 texture
        let rgba = image::DynamicImage::ImageRgba8(final_img).to_rgba8();
        let (w, h) = rgba.dimensions();

        let mut texture = texture_creator
            .create_texture_streaming(PixelFormatEnum::ABGR8888, w, h)
            .context("Failed to create blur texture")?;

        texture
            .with_lock(None, |buffer: &mut [u8], pitch: usize| {
                for y in 0..h as usize {
                    for x in 0..w as usize {
                        let pixel = rgba.get_pixel(x as u32, y as u32);
                        let offset = y * pitch + x * 4;
                        buffer[offset] = pixel[0]; // R
                        buffer[offset + 1] = pixel[1]; // G
                        buffer[offset + 2] = pixel[2]; // B
                        buffer[offset + 3] = pixel[3]; // A
                    }
                }
            })
            .map_err(|e| anyhow::anyhow!("Failed to upload blur texture: {}", e))?;

        texture.set_blend_mode(sdl2::render::BlendMode::Blend);
        Ok(texture)
    }

    /// Get the screen dimensions.
    #[allow(dead_code)]
    pub fn screen_size(&self) -> (u32, u32) {
        (self.screen_width, self.screen_height)
    }
    /// Create a texture from raw RGBA pixels (for video frames).
    pub fn create_texture_from_pixels<'a>(
        &self,
        texture_creator: &'a TextureCreator<WindowContext>,
        pixels: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Texture<'a>> {
        let mut texture = texture_creator
            .create_texture_streaming(PixelFormatEnum::ABGR8888, width, height)
            .context("Failed to create texture")?;

        texture
            .with_lock(None, |buffer: &mut [u8], pitch: usize| {
                for y in 0..height as usize {
                    let src_offset = y * (width as usize) * 4;
                    let dst_offset = y * pitch;
                    let row_bytes = (width as usize) * 4;
                    buffer[dst_offset..dst_offset + row_bytes]
                        .copy_from_slice(&pixels[src_offset..src_offset + row_bytes]);
                }
            })
            .map_err(|e| anyhow::anyhow!("Failed to update texture: {}", e))?;

        texture.set_blend_mode(sdl2::render::BlendMode::Blend);

        Ok(texture)
    }

    /// Calculate aspect-fit rectangle for displaying an image.
    fn calculate_aspect_fit(&self, img_width: u32, img_height: u32) -> Rect {
        let screen_ratio = self.screen_width as f32 / self.screen_height as f32;
        let img_ratio = img_width as f32 / img_height as f32;

        let (fit_width, fit_height) = if img_ratio > screen_ratio {
            // Image is wider than screen, fit to width
            let fit_width = self.screen_width;
            let fit_height = (self.screen_width as f32 / img_ratio) as u32;
            (fit_width, fit_height)
        } else {
            // Image is taller than screen, fit to height
            let fit_height = self.screen_height;
            let fit_width = (self.screen_height as f32 * img_ratio) as u32;
            (fit_width, fit_height)
        };

        // Center the image
        let x = ((self.screen_width - fit_width) / 2) as i32;
        let y = ((self.screen_height - fit_height) / 2) as i32;

        Rect::new(x, y, fit_width, fit_height)
    }

    /// Start a transition to the next image.
    pub fn start_transition(&mut self) {
        self.transition_state = TransitionState::TransitioningOut { progress: 0.0 };
        self.transition_start = Some(Instant::now());
    }

    /// Check if a transition is currently in progress.
    pub fn is_transitioning(&self) -> bool {
        self.transition_state != TransitionState::Idle
    }

    /// Update transition state based on elapsed time.
    pub fn update_transition(&mut self) -> bool {
        let Some(start) = self.transition_start else {
            return false;
        };

        let elapsed = start.elapsed().as_millis() as f32;
        let is_crossfade = self.transition_type == Transition::Crossfade;
        // Crossfade uses the full duration as one continuous blend; Fade splits into two halves.
        let out_duration = if is_crossfade {
            self.transition_duration_ms as f32
        } else {
            self.transition_duration_ms as f32 / 2.0
        };

        match self.transition_state {
            TransitionState::Idle => false,
            TransitionState::TransitioningOut { .. } => {
                let progress = (elapsed / out_duration).min(1.0);
                if progress >= 1.0 {
                    if is_crossfade {
                        // Crossfade is done — swap and go idle immediately.
                        self.transition_state = TransitionState::Idle;
                        self.transition_start = None;
                    } else {
                        self.transition_state = TransitionState::TransitioningIn { progress: 0.0 };
                    }
                    true // Signal to swap textures
                } else {
                    self.transition_state = TransitionState::TransitioningOut { progress };
                    false
                }
            }
            TransitionState::TransitioningIn { .. } => {
                let half = self.transition_duration_ms as f32 / 2.0;
                let progress = ((elapsed - half) / half).min(1.0);
                if progress >= 1.0 {
                    self.transition_state = TransitionState::Idle;
                    self.transition_start = None;
                } else {
                    self.transition_state = TransitionState::TransitioningIn { progress };
                }
                false
            }
        }
    }

    /// Render the current frame with optional transition effects.
    ///
    /// Takes mutable references to properly set alpha modulation on textures
    /// without using unsafe code.
    pub fn render<'a>(
        &mut self,
        texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
        current: &mut MediaTextures<'a>,
        mut next: Option<&mut MediaTextures<'a>>,
    ) -> Result<()> {
        // Clear to black
        self.canvas
            .set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        self.canvas.clear();

        let alpha = match (self.transition_type, self.transition_state) {
            (Transition::Cut, _) | (_, TransitionState::Idle) => 255u8,
            (_, TransitionState::TransitioningOut { progress }) => ((1.0 - progress) * 255.0) as u8,
            (_, TransitionState::TransitioningIn { progress }) => (progress * 255.0) as u8,
        };

        // For crossfade, we need to render next image underneath first
        if self.transition_type == Transition::Crossfade {
            if let TransitionState::TransitioningOut { progress } = self.transition_state {
                // Render next image underneath with increasing alpha
                if let Some(ref mut next_tex) = next {
                    self.render_media_textures(
                        texture_creator,
                        next_tex,
                        (progress * 255.0) as u8,
                    )?;
                }
            }
        }

        // Render current/main textures
        self.render_media_textures(texture_creator, current, alpha)?;

        if self.show_clock {
            self.render_clock(texture_creator)?;
        }

        Ok(())
    }

    /// Present the rendered frame to the screen.
    /// Must be called after all overlays have been drawn.
    pub fn present(&mut self) {
        self.canvas.present();
    }

    fn render_clock(&mut self, texture_creator: &TextureCreator<WindowContext>) -> Result<()> {
        let Some(font) = &self.font_clock else {
            return Ok(());
        };
        let clock_text = Self::format_clock_time();
        let surface = font
            .render(&clock_text)
            .blended(Color::RGBA(255, 255, 255, 118))
            .map_err(|e| anyhow::anyhow!("Failed to render clock: {}", e))?;
        let texture = texture_creator
            .create_texture_from_surface(&surface)
            .map_err(|e| anyhow::anyhow!("Failed to create clock texture: {}", e))?;
        let query = texture.query();

        let margin = (self.screen_width.min(self.screen_height) as f32 * 0.035).round() as i32;
        let x = self.screen_width as i32 - query.width as i32 - margin;
        let y = self.screen_height as i32 - query.height as i32 - margin;
        let dest = Rect::new(x, y, query.width, query.height);

        let shadow_surface = font
            .render(&clock_text)
            .blended(Color::RGBA(0, 0, 0, 44))
            .map_err(|e| anyhow::anyhow!("Failed to render clock shadow: {}", e))?;
        let shadow = texture_creator
            .create_texture_from_surface(&shadow_surface)
            .map_err(|e| anyhow::anyhow!("Failed to create clock shadow texture: {}", e))?;
        self.canvas
            .copy(
                &shadow,
                None,
                Rect::new(x + 2, y + 2, query.width, query.height),
            )
            .map_err(|e| anyhow::anyhow!("Failed to copy clock shadow: {}", e))?;
        self.canvas
            .copy(&texture, None, dest)
            .map_err(|e| anyhow::anyhow!("Failed to copy clock: {}", e))?;

        Ok(())
    }

    fn format_clock_time() -> String {
        #[cfg(unix)]
        {
            let mut now: libc::time_t = 0;
            let mut local: libc::tm = unsafe { std::mem::zeroed() };
            unsafe {
                libc::time(&mut now);
                if libc::localtime_r(&now, &mut local).is_null() {
                    return "12:00".to_string();
                }
            }
            let hour_24 = local.tm_hour;
            let hour_12 = match hour_24 % 12 {
                0 => 12,
                hour => hour,
            };
            format!("{:02}:{:02}", hour_12, local.tm_min)
        }

        #[cfg(not(unix))]
        {
            "12:00".to_string()
        }
    }

    /// Render media textures (blur background + aspect-fit display).
    /// Blur texture is pre-generated by `generate_blur_texture`; this just blits it.
    fn render_media_textures<'a>(
        &mut self,
        _texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
        textures: &mut MediaTextures<'a>,
        alpha: u8,
    ) -> Result<()> {
        if self.blur_background {
            if let Some(ref mut blur) = textures.blur {
                blur.set_alpha_mod(alpha);
                self.canvas
                    .copy(blur, None, None)
                    .map_err(|e| anyhow::anyhow!("Failed to render blur: {}", e))?;
            } else if let Some(ref mut display) = textures.display {
                // Fallback: dim the display image as the background
                if let Some((_, _)) = textures.display_size {
                    let dest_rect = Rect::new(0, 0, self.screen_width, self.screen_height);
                    display.set_color_mod(80, 80, 80);
                    display.set_alpha_mod(alpha);
                    let _ = self.canvas.copy(display, None, dest_rect);
                    display.set_color_mod(255, 255, 255);
                }
            }
        }

        // Render main display image with aspect-fit
        if let Some(ref mut display) = textures.display {
            if let Some((width, height)) = textures.display_size {
                let dest_rect = self.calculate_aspect_fit(width, height);
                display.set_alpha_mod(alpha);
                self.canvas
                    .copy(display, None, dest_rect)
                    .map_err(|e| anyhow::anyhow!("Failed to render display: {}", e))?;
            }
        }

        Ok(())
    }

    /// Process SDL events with extended action support.
    pub fn process_events_extended(&mut self) -> UserAction {
        for event in self.event_pump.poll_iter() {
            match event {
                Event::Quit { .. } => return UserAction::Quit,
                Event::KeyDown {
                    keycode: Some(key), ..
                } => {
                    match key {
                        // Quit
                        Keycode::Escape | Keycode::Q => return UserAction::Quit,
                        // Pause/Resume
                        Keycode::Space | Keycode::Return | Keycode::P => {
                            return UserAction::TogglePause
                        }
                        // Navigation
                        Keycode::Right | Keycode::Down | Keycode::N | Keycode::PageDown => {
                            return UserAction::Next
                        }
                        Keycode::Left | Keycode::Up | Keycode::B | Keycode::PageUp => {
                            return UserAction::Previous
                        }
                        // Refresh
                        Keycode::R | Keycode::F5 => return UserAction::Refresh,
                        // Toggle overlay
                        Keycode::I | Keycode::Tab | Keycode::O => return UserAction::ToggleOverlay,
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        UserAction::None
    }

    /// Sleep for a short duration to limit frame rate.
    pub fn frame_delay(&self) {
        std::thread::sleep(Duration::from_millis(16)); // ~60 FPS
    }

    /// Render the overlay with status information.
    pub fn render_overlay(&mut self, info: &OverlayInfo) -> Result<()> {
        // Semi-transparent background bar at top
        let bar_height = 60u32;
        self.canvas.set_draw_color(Color::RGBA(0, 0, 0, 180));
        self.canvas
            .fill_rect(Rect::new(0, 0, self.screen_width, bar_height))
            .map_err(|e| anyhow::anyhow!("Failed to draw overlay bg: {}", e))?;

        // Connection status indicator (circle)
        let indicator_x = 20i32;
        let indicator_y = (bar_height / 2) as i32;
        let indicator_color = if info.is_offline {
            Color::RGB(255, 100, 100) // Red for offline
        } else if info.is_connected {
            Color::RGB(100, 255, 100) // Green for connected
        } else {
            Color::RGB(255, 200, 100) // Orange for connecting
        };
        self.draw_filled_circle(indicator_x, indicator_y, 8, indicator_color)?;

        // Render text info using TTF if font is available
        if let Some(font) = &self.font_overlay {
            let texture_creator = self.canvas.texture_creator();

            // Media info text
            let status_text = if info.is_paused {
                if let Some(secs) = info.pause_secs_remaining {
                    format!(" [PAUSED {}:{:02}]", secs / 60, secs % 60)
                } else {
                    " [PAUSED]".to_string()
                }
            } else {
                String::new()
            };
            let media_text = format!(
                "{}/{} - {}{}",
                info.current_index,
                info.total_count,
                if info.media_title.len() > 30 {
                    format!("{}...", &info.media_title[..27])
                } else {
                    info.media_title.clone()
                },
                status_text
            );
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                &media_text,
                50,
                10,
                Color::WHITE,
            )?;

            // Cache info
            let cache_used_mb = info.cache_used as f64 / 1024.0 / 1024.0;
            let cache_max_mb = info.cache_max as f64 / 1024.0 / 1024.0;
            let cache_text = format!(
                "Cache: {:.1}MB / {:.1}MB ({} items)",
                cache_used_mb, cache_max_mb, info.cache_items
            );
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                &cache_text,
                50,
                35,
                Color::RGB(200, 200, 200),
            )?;

            // Connection status text (right side)
            let conn_text = if info.is_offline {
                "OFFLINE"
            } else if info.is_connected {
                "CONNECTED"
            } else {
                "CONNECTING..."
            };
            let text_width = (conn_text.len() * 12) as i32; // Approximate
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                conn_text,
                self.screen_width as i32 - text_width - 20,
                20,
                indicator_color,
            )?;
        }

        // Video progress bar (if playing video)
        if info.is_video {
            if let (Some(pos), Some(dur)) = (info.video_position, info.video_duration) {
                let bar_y = self.screen_height as i32 - 10;
                let bar_width = self.screen_width - 40;
                let progress = (pos / dur).min(1.0);

                // Background
                self.canvas.set_draw_color(Color::RGBA(100, 100, 100, 150));
                self.canvas
                    .fill_rect(Rect::new(20, bar_y, bar_width, 6))
                    .map_err(|e| anyhow::anyhow!("Failed to draw progress bg: {}", e))?;

                // Progress
                let progress_width = (bar_width as f32 * progress) as u32;
                if progress_width > 0 {
                    self.canvas.set_draw_color(Color::RGB(100, 200, 255));
                    self.canvas
                        .fill_rect(Rect::new(20, bar_y, progress_width, 6))
                        .map_err(|e| anyhow::anyhow!("Failed to draw progress: {}", e))?;
                }
            }
        }

        Ok(())
    }

    /// Render a media info overlay at the bottom-left of the screen.
    /// Uses shadow text styled like the clock — no opaque background panel.
    pub fn render_info_overlay(&mut self, info: &MediaInfoOverlay) -> Result<()> {
        let Some(font) = &self.font_info else {
            return Ok(());
        };

        let line_h = 30i32;
        let margin = (self.screen_width.min(self.screen_height) as f32 * 0.035).round() as i32;
        let mut lines: Vec<String> = Vec::new();

        if let Some(t) = &info.title {
            if !t.is_empty() {
                lines.push(t.clone());
            }
        }
        if let Some(d) = &info.description {
            if !d.is_empty() {
                lines.push(d.clone());
            }
        }
        if let Some(l) = &info.location {
            if !l.is_empty() {
                lines.push(l.clone());
            }
        }
        if !info.tags.is_empty() {
            lines.push(info.tags.join("  ·  "));
        }
        if let Some(ta) = &info.taken_at {
            if !ta.is_empty() {
                lines.push(ta.clone());
            }
        }

        // Camera make + model line
        let camera = match (&info.camera_make, &info.camera_model) {
            (Some(make), Some(model)) if !make.is_empty() && !model.is_empty() => {
                if model.to_lowercase().starts_with(&make.to_lowercase()) {
                    Some(model.clone())
                } else {
                    Some(format!("{} {}", make, model))
                }
            }
            (Some(make), None) if !make.is_empty() => Some(make.clone()),
            (None, Some(model)) if !model.is_empty() => Some(model.clone()),
            _ => None,
        };
        if let Some(c) = camera {
            lines.push(c);
        }

        // Technical line: focal length · f-number · exposure · ISO
        let mut tech_parts: Vec<String> = Vec::new();
        if let Some(fl) = &info.focal_length {
            tech_parts.push(fl.clone());
        }
        if let Some(fn_) = &info.f_number {
            tech_parts.push(fn_.clone());
        }
        if let Some(et) = &info.exposure_time {
            tech_parts.push(et.clone());
        }
        if let Some(iso) = &info.iso {
            tech_parts.push(format!("ISO {}", iso));
        }
        if !tech_parts.is_empty() {
            lines.push(tech_parts.join("  ·  "));
        }

        if let Some((w, h)) = info.dimensions {
            lines.push(format!("{}×{}", w, h));
        }

        if lines.is_empty() {
            return Ok(());
        }

        let texture_creator = self.canvas.texture_creator();
        let total_h = lines.len() as i32 * line_h;
        let start_y = self.screen_height as i32 - total_h - margin;

        for (i, line) in lines.iter().enumerate() {
            let y = start_y + i as i32 * line_h;
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                line,
                margin,
                y,
                Color::RGBA(255, 255, 255, 210),
            )?;
        }

        Ok(())
    }

    /// Draw a filled circle (approximated with rectangles for simplicity).
    fn draw_filled_circle(&mut self, cx: i32, cy: i32, radius: i32, color: Color) -> Result<()> {
        self.canvas.set_draw_color(color);
        for dy in -radius..=radius {
            let dx = ((radius * radius - dy * dy) as f32).sqrt() as i32;
            self.canvas
                .fill_rect(Rect::new(cx - dx, cy + dy, (dx * 2) as u32, 1))
                .map_err(|e| anyhow::anyhow!("Failed to draw circle: {}", e))?;
        }
        Ok(())
    }

    /// Render the discovery/pairing screen shown when no device_id is configured.
    pub fn render_discovery_screen(&mut self, pin: &str, ip: &str) -> Result<()> {
        self.canvas.set_draw_color(Color::RGB(10, 18, 35));
        self.canvas.clear();

        if let (Some(font_small), Some(font_label), Some(font_pin)) = (
            &self.font_discovery_small,
            &self.font_discovery_label,
            &self.font_discovery_pin,
        ) {
            let tc = self.canvas.texture_creator();

            let cx = (self.screen_width / 2) as i32;
            let cy = (self.screen_height / 2) as i32;

            // "Spomienka" title
            Self::render_text_centered(
                &mut self.canvas,
                font_label,
                &tc,
                "Spomienka",
                cx,
                cy - 200,
                Color::RGB(180, 200, 240),
            )?;

            // Instruction line
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "Open the admin panel and go to Settings",
                cx,
                cy - 140,
                Color::RGB(140, 160, 200),
            )?;
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "to add this viewer. Enter the PIN below:",
                cx,
                cy - 100,
                Color::RGB(140, 160, 200),
            )?;

            // PIN label
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "PIN",
                cx,
                cy - 40,
                Color::RGB(100, 130, 180),
            )?;

            // PIN value — large, bright, formatted as "123 456"
            let pin_display = format!("{} {}", &pin[..3], &pin[3..]);
            Self::render_text_centered(
                &mut self.canvas,
                font_pin,
                &tc,
                &pin_display,
                cx,
                cy - 10,
                Color::RGB(255, 230, 100),
            )?;

            // IP address
            let ip_text = format!("IP: {}", ip);
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                &ip_text,
                cx,
                cy + 110,
                Color::RGB(100, 130, 180),
            )?;

            // Searching indicator
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "Waiting for admin to connect...",
                cx,
                cy + 155,
                Color::RGB(80, 110, 160),
            )?;
        }

        self.canvas.present();
        Ok(())
    }

    fn render_text_centered(
        canvas: &mut Canvas<Window>,
        font: &sdl2::ttf::Font,
        texture_creator: &TextureCreator<WindowContext>,
        text: &str,
        cx: i32,
        y: i32,
        color: Color,
    ) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let surface = font
            .render(text)
            .blended(color)
            .map_err(|e| anyhow::anyhow!("Render text: {}", e))?;
        let texture = texture_creator
            .create_texture_from_surface(&surface)
            .map_err(|e| anyhow::anyhow!("Text texture: {}", e))?;
        let query = texture.query();
        let x = cx - (query.width as i32 / 2);
        let dest = Rect::new(x, y, query.width, query.height);
        canvas
            .copy(&texture, None, dest)
            .map_err(|e| anyhow::anyhow!("Copy text: {}", e))?;
        Ok(())
    }

    fn render_text(
        canvas: &mut Canvas<Window>,
        font: &sdl2::ttf::Font,
        texture_creator: &TextureCreator<WindowContext>,
        text: &str,
        x: i32,
        y: i32,
        color: Color,
    ) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }

        let surface = font
            .render(text)
            .blended(color)
            .map_err(|e| anyhow::anyhow!("Failed to render text: {}", e))?;

        let texture = texture_creator
            .create_texture_from_surface(&surface)
            .map_err(|e| anyhow::anyhow!("Failed to create text texture: {}", e))?;

        let query = texture.query();
        let dest = Rect::new(x, y, query.width, query.height);

        canvas
            .copy(&texture, None, dest)
            .map_err(|e| anyhow::anyhow!("Failed to copy text: {}", e))?;

        Ok(())
    }
}
