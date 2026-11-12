/** Content diagnostics from the final TeX pass, independent of exit status. */
export interface CompileDiagnostic {
  code:
    | 'missing-hyphenation'
    | 'missing-character'
    | 'font-substitution'
    | 'missing-output'
    | 'undefined-reference'
    | 'non-convergence';
  severity: 'warning' | 'error';
  message: string;
}

export function diagnose(log: string): CompileDiagnostic[] {
  const result = new Map<string, CompileDiagnostic>();
  for (const line of log.split(/\r?\n/)) {
    let code: CompileDiagnostic['code'] | undefined;
    if (/No hyphenation patterns/.test(line)) code = 'missing-hyphenation';
    else if (/Missing character:/.test(line)) code = 'missing-character';
    else if (
      /Font shape .* undefined|Some font shapes were not available|defaults substituted/.test(line)
    )
      code = 'font-substitution';
    else if (/No file .+\.(?:ind|gls|acr|nls|bbl)\./.test(line)) code = 'missing-output';
    else if (
      /There were undefined (?:references|citations)|(?:Reference|Citation) .+ undefined/.test(line)
    )
      code = 'undefined-reference';
    if (code)
      result.set(line.trim(), {
        code,
        severity: code === 'missing-character' || code === 'missing-output' ? 'error' : 'warning',
        message: line.trim(),
      });
  }
  return [...result.values()];
}
