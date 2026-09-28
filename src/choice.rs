//! A cart's shell choice as the page holds it: the `cart_shell.ini` value, empty for Automatic.

use slot_store::{Cart, Outline, Platform, ShellChoice, ShellFinish};

use crate::shell::{self, Finish, Shell};

fn value_of(s: Shell) -> String {
    let finish = match s.finish {
        Finish::Solid => ShellFinish::Solid,
        Finish::Translucent => ShellFinish::Clear,
        Finish::Glitter => ShellFinish::Glitter,
    };
    ShellChoice {
        outline: Outline::Auto,
        colour: s.colour,
        finish,
    }
    .to_value()
}

/// The shell slot picks for this cart with no choice made, as a value.
pub fn auto_shell(platform: Platform, code: &str, head: &[u8]) -> String {
    slot_store::gb::with_header(head, |rom| {
        value_of(shell::shell_for(&Cart {
            platform,
            stem: String::new(),
            rom: rom.to_path_buf(),
            label: None,
            title: String::new(),
            code: code.to_string(),
            shell: None,
        }))
    })
}

/// `name\tvalue` per preset.
pub fn presets() -> Vec<String> {
    shell::shell_presets()
        .into_iter()
        .map(|(name, s)| format!("{name}\t{}", value_of(s)))
        .collect()
}

/// Stem, value, stem, value, for every line of `text` that parses; values normalised.
pub fn cart_shells(text: &str) -> Vec<String> {
    slot_store::cart_shell::choices(text)
        .into_iter()
        .flat_map(|(stem, c)| [stem, c.to_value()])
        .collect()
}

/// `text` with each stem set to its value, or removed where the value is empty.
pub fn merge_cart_shells(
    text: &str,
    stems: &[String],
    values: &[String],
) -> std::io::Result<String> {
    let mut out = text.to_string();
    for (stem, value) in stems.iter().zip(values) {
        out = slot_store::ini::set(&out, stem, (!value.is_empty()).then_some(value.as_str()))?;
    }
    Ok(out)
}

pub fn shell_key_ok(stem: &str) -> bool {
    slot_store::ini::set("", stem, None).is_ok()
}
