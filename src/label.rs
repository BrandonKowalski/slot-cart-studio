//! The house style: a game's logo on a two-stop diagonal gradient, 1280x640.

use resvg::tiny_skia::{FilterQuality, IntSize, Pixmap, PixmapPaint, Transform};

use crate::{art, face, hue};

pub const W: u32 = 1280;
pub const H: u32 = 640;
const BOX_W: f32 = 920.0;
const BOX_H: f32 = 423.0;
/// Where a logo that fills the box's height starts. A wider logo centres on `MID_ROW` instead.
const TALL_TOP: f32 = 70.0;
const MID_ROW: f32 = 320.0;
/// Bounds ignore the faint fringe some rips carry around a logo.
const ALPHA_EDGE: u8 = 16;

/// How bright a logo has to be before the ground goes under it rather than over it. Measured on
/// slot's own carts: Fusion's silver and Ruby's white sit well above it, Zelda II's navy and the
/// Classic NES wordmarks below.
pub const BRIGHT: f32 = 110.0;

/// The ground's two corners for a hue, given how bright the logo landing on it is.
///
/// A bright logo wants a deep ground: the hand-made labels' own 82% lightness washed out Ruby's
/// white subtitle and turned gold hues to cream. A dark logo wants the opposite, because darkening
/// the ground under Zelda II's navy wordmark left neither of them readable — so it gets a pale
/// ground and the logo reads as ink on paper.
pub fn stops(hue: u16, logo_luma: f32) -> ([u8; 3], [u8; 3]) {
    let h = hue as f32;
    if logo_luma < BRIGHT {
        (
            hue::hsl_to_rgb(h, 0.55, 0.62),
            hue::hsl_to_rgb(h, 0.50, 0.84),
        )
    } else {
        let h = if (OLIVE_LO..=OLIVE_HI).contains(&hue) {
            AMBER
        } else {
            h
        };
        (
            hue::hsl_to_rgb(h, 0.65, 0.24),
            hue::hsl_to_rgb(h, 0.60, 0.46),
        )
    }
}

/// Yellow has no deep form. Taken down to the deep corner's lightness it reads as olive, which is
/// what Bomberman's ground was: the same hue at the pale corner is the cream under the Legend of
/// Zelda's wordmark, and that one reads well. So a yellow ground going deep turns toward amber
/// instead, where Advance Wars 2 already sits and looks like warm brass rather than mud.
const OLIVE_LO: u16 = 45;
const OLIVE_HI: u16 = 75;
const AMBER: f32 = 38.0;

/// The pale corner for a deep corner chosen by hand: same hue, lifted toward the light and eased
/// off in saturation by the same distance the computed pairs travel, so a picked colour sweeps
/// like a computed one instead of sitting flat.
pub fn pale_for(deep: [u8; 3]) -> [u8; 3] {
    let (h, s, l) = hue::rgb_to_hsl(deep);
    // The computed pairs travel 22 points of lightness and shed 5 of saturation, either side of
    // the brightness split; a picked colour travels the same distance.
    hue::hsl_to_rgb(h, (s - 0.05).clamp(0.0, 1.0), (l + 0.22).clamp(0.0, 1.0))
}

/// Opaque RGBA between two corners. The gradient leans on x far more than y, so it reads as
/// diagonal on a wide label.
pub fn gradient(deep: [u8; 3], pale: [u8; 3]) -> Vec<u8> {
    let mut px = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            let t = 0.88 * x as f32 / W as f32 + 0.12 * y as f32 / H as f32;
            for c in 0..3 {
                px.push((deep[c] as f32 + (pale[c] as f32 - deep[c] as f32) * t).round() as u8);
            }
            px.push(255);
        }
    }
    px
}

/// The visible part of a logo as `(x0, y0, x1, y1)`, far edges exclusive. `None` when nothing
/// is visible.
pub fn trim(rgba: &[u8], w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let mut bounds: Option<(u32, u32, u32, u32)> = None;
    for y in 0..h {
        for x in 0..w {
            if rgba[((y * w + x) * 4 + 3) as usize] < ALPHA_EDGE {
                continue;
            }
            bounds = Some(match bounds {
                None => (x, y, x + 1, y + 1),
                Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1)),
            });
        }
    }
    bounds
}

/// Scale and top left for a trimmed logo: one factor that fits the 920x423 box, centred across.
pub fn placement(w: u32, h: u32) -> (f32, f32, f32) {
    let by_w = BOX_W / w as f32;
    let by_h = BOX_H / h as f32;
    let scale = by_w.min(by_h);
    let x = (W as f32 - w as f32 * scale) / 2.0;
    let y = if by_h <= by_w {
        TALL_TOP
    } else {
        MID_ROW - h as f32 * scale / 2.0
    };
    (scale, x, y)
}

/// The logo's visible part, premultiplied, because that is what tiny-skia draws.
fn premultiplied(logo: &[u8], w: u32, (x0, y0, x1, y1): (u32, u32, u32, u32)) -> Vec<u8> {
    let mut out = Vec::with_capacity(((x1 - x0) * (y1 - y0) * 4) as usize);
    for y in y0..y1 {
        for x in x0..x1 {
            let i = ((y * w + x) * 4) as usize;
            let a = logo[i + 3] as u32;
            for c in 0..3 {
                out.push(((logo[i + c] as u32 * a + 127) / 255) as u8);
            }
            out.push(a as u8);
        }
    }
    out
}

/// The logo over the gradient, as opaque RGBA.
pub fn compose(logo: &[u8], w: u32, h: u32, deep: [u8; 3], pale: [u8; 3]) -> Vec<u8> {
    let ground = gradient(deep, pale);
    let Some(bounds) = trim(logo, w, h) else {
        return ground;
    };
    let (tw, th) = (bounds.2 - bounds.0, bounds.3 - bounds.1);
    let Some(src) = IntSize::from_wh(tw, th)
        .and_then(|size| Pixmap::from_vec(premultiplied(logo, w, bounds), size))
    else {
        return ground;
    };
    let size = IntSize::from_wh(W, H).expect("the label's size is not zero");
    let mut dst = Pixmap::from_vec(ground, size).expect("the gradient is W by H");
    let (scale, x, y) = placement(tw, th);
    let paint = PixmapPaint {
        quality: FilterQuality::Bicubic,
        ..PixmapPaint::default()
    };
    dst.draw_pixmap(
        0,
        0,
        src.as_ref(),
        &paint,
        Transform::from_row(scale, 0.0, 0.0, scale, x, y),
        None,
    );
    // The ground is opaque everywhere, so premultiplied and straight are the same bytes.
    dst.take()
}

/// One logo over a ground, recomposed whenever that ground's colour moves.
pub struct Label {
    logo: Vec<u8>,
    w: u32,
    h: u32,
    deep: [u8; 3],
    rgba: Vec<u8>,
}

impl Label {
    /// `None` for bytes slot's decoder would refuse. `deep` is the ground's top-left corner,
    /// whether the page computed it from box art or you picked it by hand; the pale corner is
    /// derived from it, so one colour describes the whole ground.
    pub fn from_png(png: &[u8], deep: [u8; 3]) -> Option<Label> {
        let (logo, w, h) = art::decode(png)?;
        let rgba = compose(&logo, w, h, deep, pale_for(deep));
        Some(Label {
            logo,
            w,
            h,
            deep,
            rgba,
        })
    }

    pub fn deep(&self) -> Vec<u8> {
        self.deep.to_vec()
    }

    pub fn set_deep(&mut self, deep: &[u8]) {
        self.deep = [deep[0], deep[1], deep[2]];
        self.rgba = compose(&self.logo, self.w, self.h, self.deep, pale_for(self.deep));
    }

    /// Slot's cart face with this label on it.
    pub fn face(&self, code: &str, stem: &str) -> Vec<u8> {
        face::from_rgba(&self.rgba, W, H, code, stem)
    }

    /// Opaque 8-bit RGB, which is all a card's label needs.
    pub fn png(&self) -> Vec<u8> {
        let rgb: Vec<u8> = self
            .rgba
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, W, H);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header()
                .expect("a PNG header writes into a Vec")
                .write_image_data(&rgb)
                .expect("PNG data writes into a Vec");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: [u8; 4] = [10, 200, 30, 255];

    fn solid(w: u32, h: u32) -> Vec<u8> {
        INK.repeat((w * h) as usize)
    }

    fn at(rgba: &[u8], x: u32, y: u32) -> [u8; 3] {
        let i = ((y * W + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2]]
    }

    /// The first and last rows, down column 640, where the label isn't bare gradient.
    /// A ground for tests: the computed pair for a hue, under a logo bright enough to keep the
    /// deep treatment, which is what every placement test below draws on.
    fn ground_for(hue: u16) -> ([u8; 3], [u8; 3]) {
        stops(hue, BRIGHT + 1.0)
    }

    fn logo_rows(label: &[u8], hue: u16) -> (u32, u32) {
        let (deep, pale) = ground_for(hue);
        let ground = gradient(deep, pale);
        let rows: Vec<u32> = (0..H)
            .filter(|y| at(label, 640, *y) != at(&ground, 640, *y))
            .collect();
        (rows[0], *rows.last().expect("a logo row"))
    }

    fn near(a: [u8; 3], b: [u8; 3], by: i32) -> bool {
        (0..3).all(|c| (a[c] as i32 - b[c] as i32).abs() <= by)
    }

    /// The olive band, at both its edges and on the branch it must not touch. Bomberman's ground
    /// was hue 55 taken deep, and the Legend of Zelda's cream is that same hue taken pale: the
    /// rotation is for the first and would ruin the second.
    #[test]
    fn a_yellow_ground_going_deep_turns_to_amber() {
        let bright = BRIGHT + 1.0;
        assert_eq!(stops(55, bright), stops(AMBER as u16, bright));
        assert_eq!(stops(OLIVE_LO, bright), stops(AMBER as u16, bright));
        assert_eq!(stops(OLIVE_HI, bright), stops(AMBER as u16, bright));

        // A hue either side of the band keeps its own, Advance Wars 2's amber cover included.
        for hue in [OLIVE_LO - 1, OLIVE_HI + 1, 35, 105, 235] {
            assert_eq!(
                stops(hue, bright).0,
                hue::hsl_to_rgb(hue as f32, 0.65, 0.24),
                "hue {hue} was turned"
            );
        }

        // A dark logo takes the pale branch, which the rotation never reaches.
        let dark = BRIGHT - 1.0;
        assert_eq!(stops(55, dark).0, hue::hsl_to_rgb(55.0, 0.55, 0.62));
    }

    #[test]
    fn the_corners_are_the_stops() {
        let (deep, pale) = ground_for(200);
        let g = gradient(deep, pale);
        assert_eq!(at(&g, 0, 0), deep);
        // The house formula puts t at 0.9991 here, not 1.
        assert!(near(at(&g, W - 1, H - 1), pale, 1));
    }

    #[test]
    fn a_bright_logo_gets_a_deep_ground_and_a_dark_one_gets_a_pale_ground() {
        assert_eq!(
            stops(0, BRIGHT + 1.0),
            (
                hue::hsl_to_rgb(0.0, 0.65, 0.24),
                hue::hsl_to_rgb(0.0, 0.60, 0.46)
            )
        );
        assert_eq!(
            stops(0, BRIGHT - 1.0),
            (
                hue::hsl_to_rgb(0.0, 0.55, 0.62),
                hue::hsl_to_rgb(0.0, 0.50, 0.84)
            )
        );
    }

    #[test]
    fn a_picked_colour_keeps_its_hue_and_lifts_toward_the_light() {
        let deep = hue::hsl_to_rgb(210.0, 0.65, 0.24);
        let pale = pale_for(deep);
        let (dh, ds, dl) = hue::rgb_to_hsl(deep);
        let (ph, ps, pl) = hue::rgb_to_hsl(pale);
        assert!((ph - dh).abs() <= 1.0, "hue moved from {dh} to {ph}");
        assert!(pl > dl, "pale {pl} is not lighter than deep {dl}");
        assert!((pl - dl - 0.22).abs() <= 0.01, "lift was {}", pl - dl);
        assert!(ps < ds, "pale {ps} is not eased off {ds}");
    }

    #[test]
    fn a_tall_logo_fills_rows_70_to_493() {
        let (deep, pale) = ground_for(30);
        let label = compose(&solid(100, 100), 100, 100, deep, pale);
        let (first, last) = logo_rows(&label, 30);
        assert!((69..=71).contains(&first), "first logo row {first}");
        assert!((491..=493).contains(&last), "last logo row {last}");
        assert!(near(at(&label, 640, 280), [INK[0], INK[1], INK[2]], 2));
    }

    #[test]
    fn a_wide_logo_centres_on_row_320() {
        let (deep, pale) = ground_for(30);
        let label = compose(&solid(400, 40), 400, 40, deep, pale);
        let (first, last) = logo_rows(&label, 30);
        let mid = (first + last) as f32 / 2.0;
        assert!((mid - 320.0).abs() <= 1.0, "logo centred on row {mid}");
        // 920 wide from 400 is a scale of 2.3, so 92 rows.
        assert!((90..=93).contains(&(last - first)), "rows {first}..{last}");
    }

    #[test]
    fn transparent_margins_and_a_faint_fringe_do_not_count() {
        let mut logo = vec![0u8; 200 * 200 * 4];
        for y in 50..150 {
            for x in 50..150 {
                let i = (y * 200 + x) * 4;
                logo[i..i + 4].copy_from_slice(&INK);
            }
        }
        logo[3] = 15;
        assert_eq!(trim(&logo, 200, 200), Some((50, 50, 150, 150)));
        let (deep, pale) = ground_for(30);
        assert!(
            compose(&logo, 200, 200, deep, pale) == compose(&solid(100, 100), 100, 100, deep, pale)
        );
    }

    #[test]
    fn an_invisible_logo_leaves_the_bare_gradient() {
        let (deep, pale) = ground_for(90);
        assert!(compose(&[0u8; 16 * 16 * 4], 16, 16, deep, pale) == gradient(deep, pale));
    }

    #[test]
    fn the_png_is_1280_by_640_rgb() {
        let mut logo = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut logo, 8, 4);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header()
                .unwrap()
                .write_image_data(&solid(8, 4))
                .unwrap();
        }
        let deep = hue::hsl_to_rgb(45.0, 0.65, 0.24);
        let label = Label::from_png(&logo, deep).expect("logo decodes");
        assert_eq!(label.deep(), deep.to_vec());
        let out = label.png();
        let reader = png::Decoder::new(std::io::Cursor::new(out))
            .read_info()
            .unwrap();
        let info = reader.info();
        assert_eq!(
            (info.width, info.height, info.color_type, info.bit_depth),
            (W, H, png::ColorType::Rgb, png::BitDepth::Eight)
        );
    }

    #[test]
    fn bytes_that_are_not_a_png_make_no_label() {
        assert!(Label::from_png(b"not a png", [101, 68, 21]).is_none());
    }
}
