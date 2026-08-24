import type { PaginationMeta } from './pagination';

// ─── Money object used by serializer ───

export interface Money {
  amountMinor: number;
  currencyCode: string;
}

// ─── Response types — matches MenuSerializer.serialize_menu_item/1 ───

export interface MenuItemVariantResponse {
  id: string;
  name: string;
  price: Money;
}

export interface MenuItemAddonResponse {
  id: string;
  name: string;
  pricingType: string;
  amountMinor: number;
  currencyCode: string;
}

export interface MenuItemCategory {
  id: string;
  name: string;
}

export interface MenuItemBusiness {
  id: string;
  name: string;
  distance?: number;
  is_open?: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  basePrice: Money;
  image_url: string | null;
  is_available: boolean;
  dietary_tags: string[];
  category_id: string;
  business_id: string;
  category: MenuItemCategory | null;
  variants: MenuItemVariantResponse[];
  extras: MenuItemAddonResponse[];
  business?: MenuItemBusiness;
  inserted_at: string;
  updated_at: string;
}

export interface MenuItemResponse {
  data: MenuItem;
}

export interface MenuItemListResponse {
  data: MenuItem[];
  pagination: PaginationMeta;
}

// ─── Request types for create/update ───

export interface MenuItemVariant {
  id: string;
  name: string;
  price_adjustment: number;
}

export interface MenuItemAddon {
  id: string;
  name: string;
  price_minor: number;
}

export interface MenuCategory {
  id: string;
  name: string;
  sort_order: number;
  is_global: boolean;
  is_system: boolean;
  pending_global_request: boolean;
}

export interface MenuCategoryListResponse {
  data: MenuCategory[];
}

export interface CatalogItemRequest {
  name: string;
  description: string;
  price_minor: number;
  category_id: string;
  currency_code: string;
  dietary_tags?: string[];
  variants: {
    name: string;
    price_adjustment: number;
  }[];
  extras: {
    name: string;
    price_minor: number;
  }[];
  available: boolean;
  image_url?: string | null;
}
