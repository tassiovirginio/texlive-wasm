//! Typed engine wrappers — argv builders.
//!
//! Rust port of `src/engines/*.ts`. The wrapper classes were intentionally
//! thin: they format argv, set sensible defaults, and forward to the engine.
//! Here that is just a function per engine returning the argument vector.

use serde::Deserialize;

use crate::core::types::EngineId;

/// How the TeX engine handles errors (`--interaction=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interaction {
    Nonstopmode,
    Batchmode,
    Errorstopmode,
    Scrollmode,
}

impl Interaction {
    pub fn as_str(self) -> &'static str {
        match self {
            Interaction::Nonstopmode => "nonstopmode",
            Interaction::Batchmode => "batchmode",
            Interaction::Errorstopmode => "errorstopmode",
            Interaction::Scrollmode => "scrollmode",
        }
    }
}

fn default_interaction() -> Interaction {
    Interaction::Nonstopmode
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfLatexCompileOptions {
    pub main_tex: String,
    #[serde(default = "default_interaction")]
    pub interaction: Interaction,
    /// `pdf` (default) or `dvi`.
    #[serde(default)]
    pub output_format: Option<String>,
    /// Halt the engine on the first error. Default: true.
    #[serde(default)]
    pub halt_on_error: Option<bool>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn pdflatex_compile_args(o: &PdfLatexCompileOptions) -> Vec<String> {
    let mut args = vec![
        "--no-shell-escape".to_string(),
        format!("--interaction={}", o.interaction.as_str()),
    ];
    if o.halt_on_error.unwrap_or(true) {
        args.push("--halt-on-error".to_string());
    }
    args.push(format!(
        "--output-format={}",
        o.output_format.as_deref().unwrap_or("pdf")
    ));
    args.extend(o.extra_args.iter().cloned());
    args.push(o.main_tex.clone());
    args
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XeLatexCompileOptions {
    pub main_tex: String,
    #[serde(default = "default_interaction")]
    pub interaction: Interaction,
    /// Keep the `.xdv` and finalize with the separate xdvipdfmx engine.
    /// Default: true (the WASM build cannot `popen` xdvipdfmx).
    #[serde(default)]
    pub no_pdf: Option<bool>,
    #[serde(default)]
    pub halt_on_error: Option<bool>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn xelatex_compile_args(o: &XeLatexCompileOptions) -> Vec<String> {
    let mut args = vec![
        "--no-shell-escape".to_string(),
        format!("--interaction={}", o.interaction.as_str()),
    ];
    if o.halt_on_error.unwrap_or(true) {
        args.push("--halt-on-error".to_string());
    }
    if o.no_pdf.unwrap_or(true) {
        args.push("--no-pdf".to_string());
    }
    args.extend(o.extra_args.iter().cloned());
    args.push(o.main_tex.clone());
    args
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaLatexCompileOptions {
    pub main_tex: String,
    #[serde(default = "default_interaction")]
    pub interaction: Interaction,
    #[serde(default)]
    pub halt_on_error: Option<bool>,
    /// Disable luasocket. Default: true (the WASM build has no real network).
    #[serde(default)]
    pub no_socket: Option<bool>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn lualatex_compile_args(o: &LuaLatexCompileOptions) -> Vec<String> {
    let mut args = vec![
        "--no-shell-escape".to_string(),
        format!("--interaction={}", o.interaction.as_str()),
    ];
    if o.halt_on_error.unwrap_or(true) {
        args.push("--halt-on-error".to_string());
    }
    if o.no_socket.unwrap_or(true) {
        args.push("--nosocket".to_string());
    }
    args.extend(o.extra_args.iter().cloned());
    args.push(o.main_tex.clone());
    args
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BibtexuOptions {
    /// Aux file path (without the `.aux` extension is fine).
    pub aux_file: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn bibtexu_args(o: &BibtexuOptions) -> Vec<String> {
    let mut args = o.extra_args.clone();
    args.push(o.aux_file.clone());
    args
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiberOptions {
    /// Jobname — the `.bcf` basename, with or without the extension.
    pub jobname: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn biber_args(o: &BiberOptions) -> Vec<String> {
    let mut args = vec!["/biber/bin/biber".to_string(), "--noconf".to_string()];
    args.extend(o.extra_args.iter().cloned());
    args.push(strip_bcf(&o.jobname));
    args
}

fn strip_bcf(jobname: &str) -> String {
    let lower = jobname.to_ascii_lowercase();
    if lower.ends_with(".bcf") {
        jobname[..jobname.len() - 4].to_string()
    } else {
        jobname.to_string()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakeindexOptions {
    pub idx_file: String,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn makeindex_args(o: &MakeindexOptions) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(style) = &o.style {
        args.push("-s".to_string());
        args.push(style.clone());
    }
    if let Some(output) = &o.output {
        args.push("-o".to_string());
        args.push(output.clone());
    }
    args.extend(o.extra_args.iter().cloned());
    args.push(o.idx_file.clone());
    args
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XdvipdfmxOptions {
    pub xdv: String,
    pub pdf: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

pub fn xdvipdfmx_args(o: &XdvipdfmxOptions) -> Vec<String> {
    let mut args = vec!["-o".to_string(), o.pdf.clone()];
    args.extend(o.extra_args.iter().cloned());
    args.push(o.xdv.clone());
    args
}

/// Build argv for `engine` from a JSON options bag — the shape the wasm
/// binding accepts from JS.
pub fn compile_args(engine: EngineId, options_json: &str) -> Result<Vec<String>, String> {
    match engine {
        EngineId::PdfLatex => {
            let o: PdfLatexCompileOptions = parse(options_json)?;
            Ok(pdflatex_compile_args(&o))
        }
        EngineId::XeLatex => {
            let o: XeLatexCompileOptions = parse(options_json)?;
            Ok(xelatex_compile_args(&o))
        }
        EngineId::LuaLatex => {
            let o: LuaLatexCompileOptions = parse(options_json)?;
            Ok(lualatex_compile_args(&o))
        }
        EngineId::Bibtexu => {
            let o: BibtexuOptions = parse(options_json)?;
            Ok(bibtexu_args(&o))
        }
        EngineId::Biber => {
            let o: BiberOptions = parse(options_json)?;
            Ok(biber_args(&o))
        }
        EngineId::Makeindex => {
            let o: MakeindexOptions = parse(options_json)?;
            Ok(makeindex_args(&o))
        }
        EngineId::Xdvipdfmx => {
            let o: XdvipdfmxOptions = parse(options_json)?;
            Ok(xdvipdfmx_args(&o))
        }
    }
}

fn parse<'a, T: Deserialize<'a>>(json: &'a str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|e| format!("invalid engine options: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdflatex_defaults() {
        let o: PdfLatexCompileOptions = parse(r#"{"mainTex":"main.tex"}"#).unwrap();
        assert_eq!(
            pdflatex_compile_args(&o),
            [
                "--no-shell-escape",
                "--interaction=nonstopmode",
                "--halt-on-error",
                "--output-format=pdf",
                "main.tex"
            ]
        );
    }

    #[test]
    fn xelatex_defaults_want_no_pdf() {
        let o: XeLatexCompileOptions = parse(r#"{"mainTex":"doc.tex"}"#).unwrap();
        let args = xelatex_compile_args(&o);
        assert!(args.contains(&"--no-pdf".to_string()), "{args:?}");
    }

    #[test]
    fn biber_runs_the_bundled_script() {
        let o: BiberOptions = parse(r#"{"jobname":"main.bcf"}"#).unwrap();
        assert_eq!(biber_args(&o), ["/biber/bin/biber", "--noconf", "main"]);
    }

    #[test]
    fn bibtexu_wolfgang_then_aux() {
        let o: BibtexuOptions =
            parse(r#"{"auxFile":"main.aux","extraArgs":["--wolfgang"]}"#).unwrap();
        assert_eq!(bibtexu_args(&o), ["--wolfgang", "main.aux"]);
    }

    #[test]
    fn makeindex_and_xdvipdfmx() {
        let m: MakeindexOptions =
            parse(r#"{"idxFile":"main.idx","style":"x.ist","output":"main.ind"}"#).unwrap();
        assert_eq!(
            makeindex_args(&m),
            ["-s", "x.ist", "-o", "main.ind", "main.idx"]
        );
        let x: XdvipdfmxOptions = parse(r#"{"xdv":"main.xdv","pdf":"main.pdf"}"#).unwrap();
        assert_eq!(xdvipdfmx_args(&x), ["-o", "main.pdf", "main.xdv"]);
    }
}
