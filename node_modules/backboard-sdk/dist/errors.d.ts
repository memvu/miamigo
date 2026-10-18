/**
 * Backboard API error classes
 */
import type { Response } from 'node-fetch';
export declare class BackboardError extends Error {
    constructor(message: string);
}
export declare class BackboardAPIError extends BackboardError {
    statusCode?: number;
    response?: Response;
    constructor(message: string, statusCode?: number, response?: Response);
}
export declare class BackboardValidationError extends BackboardAPIError {
    constructor(message: string, statusCode?: number, response?: Response);
}
export declare class BackboardNotFoundError extends BackboardAPIError {
    constructor(message: string, statusCode?: number, response?: Response);
}
export declare class BackboardRateLimitError extends BackboardAPIError {
    constructor(message: string, statusCode?: number, response?: Response);
}
export declare class BackboardServerError extends BackboardAPIError {
    constructor(message: string, statusCode?: number, response?: Response);
}
//# sourceMappingURL=errors.d.ts.map