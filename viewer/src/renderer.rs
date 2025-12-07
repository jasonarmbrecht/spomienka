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

/// Result of processing events.
pub enum EventResult {
    /// Continue running.
    Continue,
    /// User requested quit.
    Quit,
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
    /// Video duration in seconds.
    pub video_duration: Option<f32>,
    /// Video position in seconds.
    pub video_position: Option<f32>,
}

/// The main renderer struct.
pub struct Renderer {
    canvas: Canvas<Window>,
    event_pump: sdl2::EventPump,
    screen_width: u32,
    screen_height: u32,
    transition_type: Transition,
    transition_duration_ms: u32,
    transition_state: TransitionState,
    transition_start: Option<Instant>,
    /// TTF context for text rendering (kept alive).
    _ttf_context: Sdl2TtfContext,
    /// Loaded font for overlay text.
    font_data: Vec<u8>,
}

/// Embedded font data (DejaVu Sans Mono - a free, open-source font).
/// We'll try system fonts first, fall back to a basic approach.
const FONT_PATHS: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arial.ttf",
];

impl Renderer {
    /// Initialize SDL2 and create a fullscreen window.
    pub fn new(transition: Transition, transition_duration_ms: u32) -> Result<Self> {
        let sdl_context = sdl2::init().map_err(|e| anyhow::anyhow!("SDL init failed: {}", e))?;
        
        let video_subsystem = sdl_context
            .video()
            .map_err(|e| anyhow::anyhow!("SDL video init failed: {}", e))?;

        // Initialize TTF
        let ttf_context = sdl2::ttf::init()
            .map_err(|e| anyhow::anyhow!("SDL TTF init failed: {}", e))?;

        // Get display mode for fullscreen resolution
        let display_mode = video_subsystem
            .desktop_display_mode(0)
            .map_err(|e| anyhow::anyhow!("Failed to get display mode: {}", e))?;

        let screen_width = display_mode.w as u32;
        let screen_height = display_mode.h as u32;

        tracing::info!(
            "Creating fullscreen window: {}x{}",
            screen_width,
            screen_height
        );

        let window = video_subsystem
            .window("Frame Viewer", screen_width, screen_height)
            .fullscreen_desktop()
            .build()
            .context("Failed to create window")?;

        let mut canvas = window
            .into_canvas()
            .accelerated()
            .present_vsync()
            .build()
            .context("Failed to create canvas")?;

        // Enable blending for overlay
        canvas.set_blend_mode(sdl2::render::BlendMode::Blend);

        // Hide cursor for kiosk mode
        sdl_context.mouse().show_cursor(false);

        // Clear to black initially
        canvas.set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        canvas.clear();
        canvas.present();

        let event_pump = sdl_context
            .event_pump()
            .map_err(|e| anyhow::anyhow!("Failed to get event pump: {}", e))?;

        // Load font data from system
        let font_data = Self::load_font_data()?;

        Ok(Self {
            canvas,
            event_pump,
            screen_width,
            screen_height,
            transition_type: transition,
            transition_duration_ms,
            transition_state: TransitionState::Idle,
            transition_start: None,
            _ttf_context: ttf_context,
            font_data,
        })
    }

    /// Try to load font data from system fonts.
    fn load_font_data() -> Result<Vec<u8>> {
        for path in FONT_PATHS {
            if let Ok(data) = std::fs::read(path) {
                tracing::debug!("Loaded font from: {}", path);
                return Ok(data);
            }
        }
        // Return empty vec if no font found - we'll skip text rendering
        tracing::warn!("No system font found, overlay text will be disabled");
        Ok(Vec::new())
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
        let img = image::open(path).context("Failed to open image")?;
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
                        buffer[offset] = pixel[0];     // R
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
        let half_duration = self.transition_duration_ms as f32 / 2.0;

        match self.transition_state {
            TransitionState::Idle => false,
            TransitionState::TransitioningOut { .. } => {
                let progress = (elapsed / half_duration).min(1.0);
                if progress >= 1.0 {
                    self.transition_state = TransitionState::TransitioningIn { progress: 0.0 };
                    true // Signal to swap textures
                } else {
                    self.transition_state = TransitionState::TransitioningOut { progress };
                    false
                }
            }
            TransitionState::TransitioningIn { .. } => {
                let progress = ((elapsed - half_duration) / half_duration).min(1.0);
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
    pub fn render(
        &mut self,
        current: &mut MediaTextures,
        next: Option<&mut MediaTextures>,
    ) -> Result<()> {
        // Clear to black
        self.canvas.set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        self.canvas.clear();

        let alpha = match (self.transition_type, self.transition_state) {
            (Transition::Cut, _) => 255,
            (Transition::Fade, TransitionState::Idle) => 255,
            (Transition::Fade, TransitionState::TransitioningOut { progress }) => {
                ((1.0 - progress) * 255.0) as u8
            }
            (Transition::Fade, TransitionState::TransitioningIn { progress }) => {
                (progress * 255.0) as u8
            }
            (Transition::Crossfade, TransitionState::Idle) => 255,
            (Transition::Crossfade, TransitionState::TransitioningOut { progress }) => {
                ((1.0 - progress) * 255.0) as u8
            }
            (Transition::Crossfade, TransitionState::TransitioningIn { progress }) => {
                (progress * 255.0) as u8
            }
        };

        // For crossfade, we need to render next image underneath first
        if self.transition_type == Transition::Crossfade {
            if let TransitionState::TransitioningOut { progress } = self.transition_state {
                // Render next image underneath with increasing alpha
                if let Some(next_tex) = next {
                    self.render_media_textures(next_tex, (progress * 255.0) as u8)?;
                }
            }
        }

        // Render current/main textures
        self.render_media_textures(current, alpha)?;

        self.canvas.present();
        Ok(())
    }

    /// Render media textures (blur background + aspect-fit display).
    /// Takes mutable reference to allow setting alpha modulation.
    fn render_media_textures(&mut self, textures: &mut MediaTextures, alpha: u8) -> Result<()> {
        // Render blurred background (stretched to fill)
        if let Some(ref mut blur) = textures.blur {
            blur.set_alpha_mod(alpha);
            self.canvas
                .copy(blur, None, None)
                .map_err(|e| anyhow::anyhow!("Failed to render blur: {}", e))?;
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

    /// Process SDL events. Returns Quit if user wants to exit.
    pub fn process_events(&mut self) -> EventResult {
        let action = self.process_events_extended();
        match action {
            UserAction::Quit => EventResult::Quit,
            _ => EventResult::Continue,
        }
    }

    /// Process SDL events with extended action support.
    pub fn process_events_extended(&mut self) -> UserAction {
        for event in self.event_pump.poll_iter() {
            match event {
                Event::Quit { .. } => return UserAction::Quit,
                Event::KeyDown { keycode: Some(key), .. } => {
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
                        Keycode::I | Keycode::Tab | Keycode::O => {
                            return UserAction::ToggleOverlay
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        UserAction::None
    }

    /// Get screen dimensions.
    pub fn screen_size(&self) -> (u32, u32) {
        (self.screen_width, self.screen_height)
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
        if !self.font_data.is_empty() {
            let ttf_context = sdl2::ttf::init()
                .map_err(|e| anyhow::anyhow!("TTF init failed: {}", e))?;
            
            // Load font from memory
            let font = ttf_context
                .load_font_from_rwops(
                    sdl2::rwops::RWops::from_bytes(&self.font_data)?,
                    24,
                )
                .map_err(|e| anyhow::anyhow!("Failed to load font: {}", e))?;

            let texture_creator = self.canvas.texture_creator();

            // Media info text
            let status_text = if info.is_paused { " [PAUSED]" } else { "" };
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
            self.render_text(&font, &texture_creator, &media_text, 50, 10, Color::WHITE)?;

            // Cache info
            let cache_used_mb = info.cache_used as f64 / 1024.0 / 1024.0;
            let cache_max_mb = info.cache_max as f64 / 1024.0 / 1024.0;
            let cache_text = format!(
                "Cache: {:.1}MB / {:.1}MB ({} items)",
                cache_used_mb, cache_max_mb, info.cache_items
            );
            self.render_text(&font, &texture_creator, &cache_text, 50, 35, Color::RGB(200, 200, 200))?;

            // Connection status text (right side)
            let conn_text = if info.is_offline {
                "OFFLINE"
            } else if info.is_connected {
                "CONNECTED"
            } else {
                "CONNECTING..."
            };
            let text_width = (conn_text.len() * 12) as i32; // Approximate
            self.render_text(
                &font,
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

    /// Render text at the specified position.
    fn render_text<'a>(
        &mut self,
        font: &sdl2::ttf::Font,
        texture_creator: &'a TextureCreator<WindowContext>,
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

        self.canvas
            .copy(&texture, None, dest)
            .map_err(|e| anyhow::anyhow!("Failed to copy text: {}", e))?;

        Ok(())
    }
}

