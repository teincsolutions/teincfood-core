/**
 * Validation Utilities
 * Provides schema validation for REST/WS/SSE/push payloads
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateEmail(email: string): ValidationResult {
  const errors: string[] = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email) {
    errors.push('Email is required');
  } else if (!emailRegex.test(email)) {
    errors.push('Invalid email format');
  }

  return { valid: errors.length === 0, errors };
}

export function validatePhone(phone: string): ValidationResult {
  const errors: string[] = [];
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;

  if (!phone) {
    errors.push('Phone number is required');
  } else if (!phoneRegex.test(phone.replace(/\s/g, ''))) {
    errors.push('Invalid phone number format');
  }

  return { valid: errors.length === 0, errors };
}

export function validateUsername(username: string): ValidationResult {
  const errors: string[] = [];
  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;

  if (!username) {
    errors.push('Username is required');
  } else if (!usernameRegex.test(username)) {
    errors.push('Username must be 3-20 characters and contain only letters, numbers, and underscores');
  }

  return { valid: errors.length === 0, errors };
}

export function validatePassword(password: string): ValidationResult {
  const errors: string[] = [];

  if (!password) {
    errors.push('Password is required');
  } else {
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters');
    }
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one number');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateOrderPayload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Order payload must be an object');
    return { valid: false, errors };
  }

  const order = payload as Record<string, unknown>;

  if (!order.id || typeof order.id !== 'string') {
    errors.push('Order ID is required');
  }

  if (!order.items || !Array.isArray(order.items)) {
    errors.push('Order items must be an array');
  }

  if (typeof order.total !== 'number' || order.total < 0) {
    errors.push('Order total must be a non-negative number');
  }

  return { valid: errors.length === 0, errors };
}

export function validateChatMessage(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Chat message payload must be an object');
    return { valid: false, errors };
  }

  const message = payload as Record<string, unknown>;

  if (!message.messageId || typeof message.messageId !== 'string') {
    errors.push('Message ID is required');
  }

  if (!message.chatId || typeof message.chatId !== 'string') {
    errors.push('Chat ID is required');
  }

  if (!message.text || typeof message.text !== 'string') {
    errors.push('Message text is required');
  }

  return { valid: errors.length === 0, errors };
}

export function validateEventEnvelope(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Event envelope must be an object');
    return { valid: false, errors };
  }

  const event = payload as Record<string, unknown>;

  if (!event.eventId || typeof event.eventId !== 'string') {
    errors.push('Event ID is required');
  }

  if (!event.type || typeof event.type !== 'string') {
    errors.push('Event type is required');
  }

  if (!event.occurredAt || typeof event.occurredAt !== 'string') {
    errors.push('Event timestamp is required');
  }

  if (typeof event.sequence !== 'number') {
    errors.push('Event sequence must be a number');
  }

  return { valid: errors.length === 0, errors };
}

export function validatePromoCode(code: string): ValidationResult {
  const errors: string[] = [];
  const promoRegex = /^[A-Z0-9]{3,20}$/;

  if (!code) {
    errors.push('Promo code is required');
  } else if (!promoRegex.test(code.toUpperCase())) {
    errors.push('Promo code must be 3-20 uppercase letters or numbers');
  }

  return { valid: errors.length === 0, errors };
}

export function validateAddress(address: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  if (!address.street || typeof address.street !== 'string') {
    errors.push('Street address is required');
  }

  if (!address.city || typeof address.city !== 'string') {
    errors.push('City is required');
  }

  if (!address.label || typeof address.label !== 'string') {
    errors.push('Address label is required');
  }

  return { valid: errors.length === 0, errors };
}

export function validatePaymentMethod(payment: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  if (!payment.type || !['card', 'mobile_money'].includes(payment.type as string)) {
    errors.push('Payment type must be card or mobile_money');
  }

  if (!payment.last4 || typeof payment.last4 !== 'string') {
    errors.push('Payment last4 digits are required');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Convenience object for screen-level validation ───

export const validation = {
  isNotEmpty: (value: string) => value.trim().length > 0,
  isValid: (value: string, validator: (v: string) => ValidationResult) => validator(value).valid,
  email: Object.assign(
    (v: string) => validateEmail(v),
    { message: "Invalid email format" },
  ),
  phone: Object.assign(
    (v: string) => validatePhone(v),
    { message: "Invalid phone number format" },
  ),
  password: Object.assign(
    (v: string) => validatePassword(v),
    { message: "Password must be at least 8 characters" },
  ),
};