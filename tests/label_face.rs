#![cfg(not(target_arch = "wasm32"))]

use slot_cart_studio::{face, label::Band, label::Label};
use slot_ui::{CART_W, LABEL_H, LABEL_W, LABEL_X, LABEL_Y};

const INK: [u8; 4] = [10, 200, 30, 255];

fn solid(w: u32, h: u32) -> Vec<u8> {
    INK.repeat((w * h) as usize)
}

fn png_of(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(rgba).unwrap();
    }
    out
}

fn near(a: [u8; 3], b: [u8; 3], by: i32) -> bool {
    (0..3).all(|c| (a[c] as i32 - b[c] as i32).abs() <= by)
}

#[test]
fn a_full_label_shows_on_the_cart_face_to_its_corners() {
    let gba = face::platform_of("GBA");
    let label = Label::full(&png_of(&solid(512, 256), 512, 256), gba).expect("decodes");
    let face = face::of_label(&label, gba, "", &[], "", "Probe");
    let (x0, y0) = (LABEL_X + 1, LABEL_Y + 1);
    let (x1, y1) = (LABEL_X + LABEL_W - 2, LABEL_Y + LABEL_H - 2);
    for (x, y) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)] {
        let i = ((y * CART_W + x) * 4) as usize;
        assert!(
            near([face[i], face[i + 1], face[i + 2]], [INK[0], INK[1], INK[2]], 24),
            "at {x},{y}: {:?}",
            &face[i..i + 3]
        );
    }
}

#[test]
fn a_thin_top_band_shows_on_the_cart_face() {
    let gba = face::platform_of("GBA");
    let band = Band::parse("top", 0.046, &[172, 13, 0]);
    let label = Label::from_png(&png_of(&solid(8, 4), 8, 4), [20, 20, 30], gba, band).expect("decodes");
    let face = face::of_label(&label, gba, "", &[], "", "Probe");
    let (x, y) = (LABEL_X + LABEL_W / 2, LABEL_Y + 1);
    let i = ((y * CART_W + x) * 4) as usize;
    assert!(
        near([face[i], face[i + 1], face[i + 2]], [172, 13, 0], 24),
        "{:?}",
        &face[i..i + 3]
    );
}
