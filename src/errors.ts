export class QethError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2 = 2) {
    super(message);
    this.name = 'QethError';
    this.exitCode = exitCode;
  }
}
