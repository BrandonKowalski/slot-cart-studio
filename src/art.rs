//! Slot's `art::cover`, fed from memory. Slot's module opens the label's path, which a browser
//! cannot do, so this one looks the path up in a stash `face` fills for the length of one draw.
//! The decode and the cover are slot's code line for line, apart from the decode's bound on the
//! frame buffer, and `tests/face.rs` holds the result to slot's pixel for pixel.

use std::cell::RefCell;
use std::path::Path;

const KEY: &str = "stash:label";

enum Stashed {
    Png(Vec<u8>),
    Rgba { px: Vec<u8>, w: u32, h: u32 },
}

thread_local! {
    static STASH: RefCell<Option<Stashed>> = const { RefCell::new(None) };
}

pub(crate) fn with_png<R>(png: &[u8], f: impl FnOnce(&Path) -> R) -> R {
    with(Stashed::Png(png.to_vec()), f)
}

pub(crate) fn with_rgba<R>(px: &[u8], w: u32, h: u32, f: impl FnOnce(&Path) -> R) -> R {
    with(
        Stashed::Rgba {
            px: px.to_vec(),
            w,
            h,
        },
        f,
    )
}

/// The stash lives for one call. A label left behind would hold megabytes for nothing, and could
/// be drawn onto the wrong cart.
fn with<R>(label: Stashed, f: impl FnOnce(&Path) -> R) -> R {
    STASH.with(|s| *s.borrow_mut() = Some(label));
    let out = f(Path::new(KEY));
    STASH.with(|s| *s.borrow_mut() = None);
    out
}

/// Slot's signature. `path` is the stash key `face` handed to `cart_face`.
pub(crate) fn cover(path: &Path, w: u32, h: u32) -> Option<Vec<u8>> {
    if path != Path::new(KEY) {
        return None;
    }
    STASH.with(|s| match s.borrow().as_ref()? {
        Stashed::Png(bytes) => {
            let (src, sw, sh) = decode(bytes)?;
            cover_rgba(&src, sw, sh, w, h)
        }
        Stashed::Rgba { px, w: sw, h: sh } => cover_rgba(px, *sw, *sh, w, h),
    })
}

pub(crate) fn cover_rgba(src: &[u8], sw: u32, sh: u32, w: u32, h: u32) -> Option<Vec<u8>> {
    if sw == 0 || sh == 0 {
        return None;
    }

    let scale = (w as f32 / sw as f32).max(h as f32 / sh as f32);
    let ox = (sw as f32 - w as f32 / scale) / 2.0;
    let oy = (sh as f32 - h as f32 / scale) / 2.0;

    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let y0 = oy + y as f32 / scale;
        let y1 = oy + (y + 1) as f32 / scale;
        for x in 0..w {
            let x0 = ox + x as f32 / scale;
            let x1 = ox + (x + 1) as f32 / scale;
            let px = box_average(src, sw, sh, x0, y0, x1, y1);
            out[((y * w + x) * 4) as usize..][..4].copy_from_slice(&px);
        }
    }
    Some(out)
}

fn box_average(src: &[u8], sw: u32, sh: u32, x0: f32, y0: f32, x1: f32, y1: f32) -> [u8; 4] {
    let xa = (x0.floor().max(0.0) as u32).min(sw - 1);
    let ya = (y0.floor().max(0.0) as u32).min(sh - 1);
    let xb = ((x1.ceil() as u32).max(xa + 1)).min(sw);
    let yb = ((y1.ceil() as u32).max(ya + 1)).min(sh);

    let mut acc = [0u32; 4];
    let mut n = 0u32;
    for y in ya..yb {
        for x in xa..xb {
            let i = ((y * sw + x) * 4) as usize;
            for c in 0..4 {
                acc[c] += src[i + c] as u32;
            }
            n += 1;
        }
    }
    let mut out = [0u8; 4];
    for c in 0..4 {
        out[c] = ((acc[c] + n / 2) / n) as u8;
    }
    out
}

pub(crate) fn decode_png_bytes(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    if bytes.starts_with(b"RIFF") {
        decode_webp(bytes)
    } else {
        decode(bytes)
    }
}

fn decode_webp(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut dec = image_webp::WebPDecoder::new(std::io::Cursor::new(bytes)).ok()?;
    let (w, h) = dec.dimensions();
    let size = dec.output_buffer_size()?;
    if size > 64 << 20 {
        return None;
    }
    let mut buf = vec![0u8; size];
    dec.read_image(&mut buf).ok()?;
    if dec.has_alpha() {
        return Some((buf, w, h));
    }
    let mut rgba = vec![255u8; (w * h) as usize * 4];
    for (to, from) in rgba.chunks_exact_mut(4).zip(buf.chunks_exact(3)) {
        to[..3].copy_from_slice(from);
    }
    Some((rgba, w, h))
}

/// Straight RGBA, with slot's decoder settings. `label` and `hue` decode through here too, so a
/// logo the studio accepts is one slot would.
pub(crate) fn decode(png: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(png));
    dec.set_transformations(png::Transformations::normalize_to_color8());
    dec.set_limits(png::Limits { bytes: 64 << 20 });

    let mut reader = dec.read_info().ok()?;
    // Unlike slot's art.rs, a frame over 64 MiB is refused before it is allocated. The limit above
    // doesn't cover this buffer, which is sized from the header alone, so a 45-byte PNG can ask
    // for gigabytes; on wasm32 that traps and leaves the page unusable.
    if reader.output_buffer_size() > 64 << 20 {
        return None;
    }
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let src = &buf[..info.buffer_size()];
    let n = (info.width * info.height) as usize;

    let mut rgba = vec![255u8; n * 4];
    match info.color_type {
        png::ColorType::Rgba => rgba.copy_from_slice(src),
        png::ColorType::Rgb => {
            for i in 0..n {
                rgba[i * 4..i * 4 + 3].copy_from_slice(&src[i * 3..i * 3 + 3]);
            }
        }
        png::ColorType::Grayscale => {
            for i in 0..n {
                rgba[i * 4..i * 4 + 3].fill(src[i]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for i in 0..n {
                rgba[i * 4..i * 4 + 3].fill(src[i * 2]);
                rgba[i * 4 + 3] = src[i * 2 + 1];
            }
        }
        png::ColorType::Indexed => return None,
    }
    Some((rgba, info.width, info.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lossy_webp_keeps_its_size_and_its_alpha() {
        let (rgba, w, h) = decode_png_bytes(include_bytes!("../tests/fixtures/lossy.webp"))
            .expect("the kind of webp the art set serves");
        assert_eq!((w, h), (32, 16));
        assert_eq!(rgba.len(), 32 * 16 * 4);
        assert_eq!(rgba[(8 * 32 + 4) * 4 + 3], 255);
        assert_eq!(rgba[(8 * 32 + 28) * 4 + 3], 0);
    }

    #[test]
    fn an_opaque_webp_comes_back_with_alpha_filled_in() {
        let mut webp = Vec::new();
        image_webp::WebPEncoder::new(&mut webp)
            .encode(&[10, 20, 30].repeat(6), 3, 2, image_webp::ColorType::Rgb8)
            .expect("encodes");
        let (rgba, w, h) = decode_png_bytes(&webp).expect("decodes");
        assert_eq!((w, h), (3, 2));
        assert_eq!(rgba, [10, 20, 30, 255].repeat(6));
    }

    #[test]
    fn a_webp_header_that_asks_for_a_huge_frame_is_refused() {
        let mut webp = b"RIFF\0\0\0\0WEBPVP8L".to_vec();
        webp.extend_from_slice(&5u32.to_le_bytes());
        webp.push(0x2f);
        webp.extend_from_slice(&(0x3fffu32 | 0x3fff << 14).to_le_bytes());
        webp.resize(32, 0);
        let len = webp.len() as u32 - 8;
        webp[4..8].copy_from_slice(&len.to_le_bytes());
        assert!(decode_png_bytes(&webp).is_none());
    }

    #[test]
    fn a_riff_that_is_not_a_webp_is_refused() {
        assert!(decode_png_bytes(b"RIFF\x04\0\0\0WAVE").is_none());
    }

    #[test]
    fn the_cover_takes_only_what_slot_can_read_from_a_card() {
        assert!(decode(include_bytes!("../tests/fixtures/lossy.webp")).is_none());
    }

    fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        png.extend_from_slice(&crc.finalize().to_be_bytes());
    }

    #[test]
    fn a_header_that_asks_for_a_huge_frame_is_refused() {
        // 20000x20000 RGBA is a 1.6 GB frame, asked for in 45 bytes with no image data in them.
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&20_000u32.to_be_bytes());
        ihdr.extend_from_slice(&20_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut png, b"IHDR", &ihdr);
        // Without an IDAT, read_info runs out of bytes first and the bound is never reached.
        chunk(&mut png, b"IDAT", &[]);

        let header = png::Decoder::new(std::io::Cursor::new(&png)).read_info();
        assert!(
            header.is_ok_and(|r| r.output_buffer_size() > 64 << 20),
            "the header alone passes read_info, so only the bound can refuse it"
        );
        assert!(decode(&png).is_none());
    }
}
