//! SDL2-based rendering module for the frame viewer.
//!
//! Handles window creation, texture management, and rendering with transitions.

use anyhow::{Context, Result};
use sdl2::event::Event;
use sdl2::keyboard::Keycode;
use sdl2::pixels::PixelFormatEnum;
use sdl2::rect::Rect;
use sdl2::render::{Canvas, Texture, TextureCreator};
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
}

impl Renderer {
    /// Initialize SDL2 and create a fullscreen window.
    pub fn new(transition: Transition, transition_duration_ms: u32) -> Result<Self> {
        let sdl_context = sdl2::init().map_err(|e| anyhow::anyhow!("SDL init failed: {}", e))?;
        
        let video_subsystem = sdl_context
            .video()
            .map_err(|e| anyhow::anyhow!("SDL video init failed: {}", e))?;

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

        // Hide cursor for kiosk mode
        sdl_context.mouse().show_cursor(false);

        // Clear to black initially
        canvas.set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        canvas.clear();
        canvas.present();

        let event_pump = sdl_context
            .event_pump()
            .map_err(|e| anyhow::anyhow!("Failed to get event pump: {}", e))?;

        Ok(Self {
            canvas,
            event_pump,
            screen_width,
            screen_height,
            transition_type: transition,
            transition_duration_ms,
            transition_state: TransitionState::Idle,
            transition_start: None,
        })
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
    pub fn render(
        &mut self,
        current: &MediaTextures,
        next: Option<&MediaTextures>,
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

        // Determine which textures to render based on transition state
        let (textures_to_render, render_alpha) = match self.transition_state {
            TransitionState::Idle | TransitionState::TransitioningOut { .. } => (current, alpha),
            TransitionState::TransitioningIn { .. } => {
                // During transition in, we want to show the next image
                // But if we're here, we should have already swapped
                (current, alpha)
            }
        };

        // For crossfade, we need to render both images
        if self.transition_type == Transition::Crossfade {
            if let TransitionState::TransitioningOut { progress } = self.transition_state {
                // Render next image underneath with increasing alpha
                if let Some(next_tex) = next {
                    self.render_media_textures(next_tex, (progress * 255.0) as u8)?;
                }
            }
        }

        // Render current/main textures
        self.render_media_textures(textures_to_render, render_alpha)?;

        self.canvas.present();
        Ok(())
    }

    /// Render media textures (blur background + aspect-fit display).
    fn render_media_textures(&mut self, textures: &MediaTextures, alpha: u8) -> Result<()> {
        // Render blurred background (stretched to fill)
        if let Some(ref blur) = textures.blur {
            let mut blur_tex = unsafe {
                // SAFETY: We need mutable access to set alpha, but we're borrowing immutably
                // This is a workaround for SDL2-rs API limitations
                std::mem::transmute::<&Texture, &mut Texture>(blur)
            };
            blur_tex.set_alpha_mod(alpha);
            self.canvas
                .copy(&blur_tex, None, None)
                .map_err(|e| anyhow::anyhow!("Failed to render blur: {}", e))?;
        }

        // Render main display image with aspect-fit
        if let Some(ref display) = textures.display {
            if let Some((width, height)) = textures.display_size {
                let dest_rect = self.calculate_aspect_fit(width, height);
                let mut display_tex = unsafe {
                    std::mem::transmute::<&Texture, &mut Texture>(display)
                };
                display_tex.set_alpha_mod(alpha);
                self.canvas
                    .copy(&display_tex, None, dest_rect)
                    .map_err(|e| anyhow::anyhow!("Failed to render display: {}", e))?;
            }
        }

        Ok(())
    }

    /// Process SDL events. Returns Quit if user wants to exit.
    pub fn process_events(&mut self) -> EventResult {
        for event in self.event_pump.poll_iter() {
            match event {
                Event::Quit { .. } => return EventResult::Quit,
                Event::KeyDown {
                    keycode: Some(Keycode::Escape),
                    ..
                } => return EventResult::Quit,
                Event::KeyDown {
                    keycode: Some(Keycode::Q),
                    ..
                } => return EventResult::Quit,
                _ => {}
            }
        }
        EventResult::Continue
    }

    /// Get screen dimensions.
    pub fn screen_size(&self) -> (u32, u32) {
        (self.screen_width, self.screen_height)
    }

    /// Sleep for a short duration to limit frame rate.
    pub fn frame_delay(&self) {
        std::thread::sleep(Duration::from_millis(16)); // ~60 FPS
    }
}

