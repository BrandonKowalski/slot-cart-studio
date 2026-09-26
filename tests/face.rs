//! The studio's faces against slot's, pixel for pixel. Slot's `cart_face` reads a real card in a
//! temp dir; the studio's reads the same bytes from memory. Any difference is the studio
//! drifting from the device.

#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use slot_cart_studio::face;
use tempfile::TempDir;

const EMERALD: &str = "BPEE";
/// Neither in slot's shell table nor a family letter, so the default grey shell.
const PLAIN: &str = "AMTE";
const STEM: &str = "Probe Cart (USA)";

/// A card in the shape slot reads now: every file under the folder its platform names. `dir` is
/// that folder, `GBA` or `GB`, which is also how the studio names a platform across the wasm
/// boundary.
fn card(dir: &str, code: &str, cgb: u8, label: &[u8]) -> TempDir {
    let d = tempfile::tempdir().expect("tempdir");
    for sub in ["Games", "Labels"] {
        std::fs::create_dir_all(d.path().join(sub).join(dir)).expect("content dir");
    }
    // Long enough for either header: a GBA game code sits at 0xAC, a Game Boy title at 0x134.
    let mut rom = vec![0u8; 0x200];
    if !code.is_empty() {
        rom[0xac..0xac + code.len()].copy_from_slice(code.as_bytes());
    }
    rom[0x143] = cgb;
    let ext = dir.to_lowercase();
    std::fs::write(d.path().join(format!("Games/{dir}/{STEM}.{ext}")), rom).expect("rom");
    std::fs::write(d.path().join(format!("Labels/{dir}/{STEM}.png")), label).expect("label");
    d
}

/// Slot's face for the only cart on `root`, with the code and stem slot read for it.
fn slot_face(root: &Path) -> (Vec<u8>, String, String) {
    let carts = slot_store::scan(root).expect("scan");
    let cart = &carts[0];
    (
        slot_ui::cart_face(cart).rgba,
        cart.code.clone(),
        cart.stem.clone(),
    )
}

fn encode(w: u32, h: u32, colour: png::ColorType, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(colour);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()
            .expect("png header")
            .write_image_data(data)
            .expect("png data");
    }
    out
}

fn pixels<const N: usize>(w: u32, h: u32, px: impl Fn(u32, u32) -> [u8; N]) -> Vec<u8> {
    (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .flat_map(|(x, y)| px(x, y))
        .collect()
}

fn png_rgb(w: u32, h: u32, px: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    encode(w, h, png::ColorType::Rgb, &pixels(w, h, px))
}

fn png_rgba(w: u32, h: u32, px: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    encode(w, h, png::ColorType::Rgba, &pixels(w, h, px))
}

fn assert_same_as_slot(label: &[u8]) {
    // A GBA cart slot's shell table knows, one that falls through to the default grey, and a Game
    // Boy pak for each CGB flag: grey, black and clear, the last in its own rounded mould. A pak
    // filed under the other Game Boy folder still takes its shell from the flag, not the folder.
    for (dir, code, cgb) in [
        ("GBA", EMERALD, 0),
        ("GBA", PLAIN, 0),
        ("GB", "", 0x00),
        ("GB", "", 0x80),
        ("GB", "", 0xc0),
        ("GBC", "", 0x00),
        ("GBC", "", 0xc0),
    ] {
        let d = card(dir, code, cgb, label);
        let (want, read_code, stem) = slot_face(d.path());
        assert_eq!(read_code, code, "slot did not read the code back");
        assert!(
            want == face::from_png(label, face::platform_of(dir), &read_code, cgb, &stem),
            "face differs from slot's in {dir} with code {code:?} and CGB flag {cgb:#04x}"
        );
    }
}

#[test]
fn a_flat_opaque_label_matches_slot() {
    assert_same_as_slot(&png_rgb(64, 64, |_, _| [0xd0, 0x20, 0xa0]));
}

#[test]
fn a_label_with_partial_alpha_matches_slot() {
    assert_same_as_slot(&png_rgba(196, 86, |x, y| {
        [x as u8, y as u8, 0x40, ((x * 3 + y) % 256) as u8]
    }));
}

#[test]
fn a_tall_label_is_cropped_the_way_slot_crops_it() {
    assert_same_as_slot(&png_rgb(160, 480, |_, y| match y / 160 {
        0 => [255, 0, 0],
        1 => [0, 255, 0],
        _ => [0, 0, 255],
    }));
}

#[test]
fn bytes_that_are_not_a_png_get_slots_generated_label() {
    assert_same_as_slot(b"not a png");
}

#[test]
fn raw_rgba_draws_the_same_face_as_its_png() {
    let (w, h) = (300, 150);
    let px = |x: u32, y: u32| [(x % 256) as u8, (y % 256) as u8, 0x80, 255];
    let png = png_rgba(w, h, px);
    let raw = pixels(w, h, px);
    for code in [EMERALD, PLAIN] {
        let d = card("GBA", code, 0, &png);
        let (want, _, stem) = slot_face(d.path());
        assert!(
            want == face::from_rgba(&raw, w, h, face::platform_of("GBA"), code, 0, &stem),
            "raw RGBA face differs with code {code}"
        );
    }
}

#[test]
fn a_composed_label_matches_slot_reading_its_png() {
    let logo = png_rgba(120, 60, |x, y| {
        if (x / 10 + y / 10) % 2 == 0 {
            [250, 210, 20, 255]
        } else {
            [0, 0, 0, 0]
        }
    });
    let deep = slot_cart_studio::hue::hsl_to_rgb(210.0, 0.65, 0.24);
    let label = slot_cart_studio::label::Label::from_png(&logo, deep, face::platform_of("GBA"))
        .expect("logo decodes");
    let png = label.png();
    for code in [EMERALD, PLAIN] {
        let d = card("GBA", code, 0, &png);
        let (want, _, stem) = slot_face(d.path());
        assert!(
            want == label.face(face::platform_of("GBA"), code, 0, &stem),
            "composed face differs with code {code}"
        );
    }
}

#[test]
fn the_game_code_is_read_the_way_slot_reads_it() {
    for code in [EMERALD, PLAIN, "AB", ""] {
        let d = card("GBA", code, 0, b"");
        let (_, slot_code, _) = slot_face(d.path());
        let rom = std::fs::read(d.path().join(format!("Games/GBA/{STEM}.gba"))).expect("rom");
        assert_eq!(
            slot_cart_studio::rom::header_code(&rom[..0xb0]),
            slot_code,
            "{code:?}"
        );
    }
}
