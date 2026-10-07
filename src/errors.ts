import type { ToolError } from './contracts.js';

export class ToolFailure extends Error {
  readonly error: ToolError;

  constructor(error: ToolError) {
    super(error.message);
    this.name = 'ToolFailure';
    this.error = error;
  }
}
