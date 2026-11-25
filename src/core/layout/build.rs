use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn rust_path(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}

fn read(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap_or_else(|error| {
        panic!("failed to read {relative}: {error}");
    })
}

fn write(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap_or_else(|error| {
        panic!("failed to write {}: {error}", path.display());
    });
}

fn module_source(contents: String) -> String {
    contents
        .lines()
        .map(|line| {
            line.strip_prefix("//!")
                .map_or_else(|| line.to_owned(), |rest| format!("//{rest}"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));

    let html5ever_lib = manifest_dir.join("../html5ever/lib.rs");
    let html5ever_sink = manifest_dir.join("../html5ever/sink.rs");
    let html5ever_types = manifest_dir.join("../html5ever/types.rs");
    let stylo_lib = manifest_dir.join("../stylo/lib.rs");
    let stylo_stylist_store = manifest_dir.join("../stylo/stylist_store.rs");
    let stylo_dom_adapter = manifest_dir.join("../stylo/dom_adapter.rs");

    let mut html_lib = read(&manifest_dir, "../html5ever/lib.rs");
    html_lib = html_lib.replace(
        "mod sink;",
        &format!(
            "#[path = {}] mod sink;",
            rust_path(&out_dir.join("html5ever_sink.rs"))
        ),
    );
    html_lib = html_lib.replace(
        "mod types;",
        &format!(
            "#[path = {}] mod types;",
            rust_path(&out_dir.join("html5ever_types.rs"))
        ),
    );

    let html_sink = read(&manifest_dir, "../html5ever/sink.rs")
        .replace("use crate::types::*;", "use super::types::*;");
    let html_types = read(&manifest_dir, "../html5ever/types.rs");

    let mut stylo_source = module_source(read(&manifest_dir, "../stylo/lib.rs"));
    stylo_source = stylo_source.replace(
        "mod dom_adapter;",
        &format!(
            "#[path = {}] mod dom_adapter;",
            rust_path(&stylo_dom_adapter)
        ),
    );
    stylo_source = stylo_source.replace(
        "mod stylist_store;",
        &format!(
            "#[path = {}] mod stylist_store;",
            rust_path(&out_dir.join("stylo_stylist_store.rs"))
        ),
    );

    let stylo_store =
        read(&manifest_dir, "../stylo/stylist_store.rs").replace("use crate::{", "use super::{");

    write(&out_dir.join("html5ever_bridge.rs"), &html_lib);
    write(&out_dir.join("html5ever_sink.rs"), &html_sink);
    write(&out_dir.join("html5ever_types.rs"), &html_types);
    write(&out_dir.join("stylo_bridge.rs"), &stylo_source);
    write(&out_dir.join("stylo_stylist_store.rs"), &stylo_store);

    for path in [
        html5ever_lib,
        html5ever_sink,
        html5ever_types,
        stylo_lib,
        stylo_stylist_store,
        stylo_dom_adapter,
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}
