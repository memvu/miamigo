export class BackboardError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BackboardError';
    }
}
export class BackboardAPIError extends BackboardError {
    constructor(message, statusCode, response) {
        super(message);
        this.name = 'BackboardAPIError';
        this.statusCode = statusCode;
        this.response = response;
    }
}
export class BackboardValidationError extends BackboardAPIError {
    constructor(message, statusCode, response) {
        super(message, statusCode, response);
        this.name = 'BackboardValidationError';
    }
}
export class BackboardNotFoundError extends BackboardAPIError {
    constructor(message, statusCode, response) {
        super(message, statusCode, response);
        this.name = 'BackboardNotFoundError';
    }
}
export class BackboardRateLimitError extends BackboardAPIError {
    constructor(message, statusCode, response) {
        super(message, statusCode, response);
        this.name = 'BackboardRateLimitError';
    }
}
export class BackboardServerError extends BackboardAPIError {
    constructor(message, statusCode, response) {
        super(message, statusCode, response);
        this.name = 'BackboardServerError';
    }
}
//# sourceMappingURL=errors.js.map