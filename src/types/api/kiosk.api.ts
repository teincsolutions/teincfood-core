import type { PaginatedResponse } from './pagination';
import type { SellerOrder } from './seller.api';

// The kiosk uses the same order endpoint as seller orders.
// KioskOrder is an alias for SellerOrder — same shape, fields match backend.

export type KioskOrder = SellerOrder;

export type KioskOrdersResponse = PaginatedResponse<KioskOrder>;
