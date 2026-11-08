/** An error with a short machine-readable code (the same words the database raises, e.g. report_already_sent). */
export class ReportError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ReportError"; }
}
export class ReportTooLargeError extends ReportError {
  constructor(public bytes: number, public limit: number) {
    super("report_too_large", `The PDF is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${(limit / 1024 / 1024).toFixed(0)} MB. Nothing was saved.`);
  }
}
