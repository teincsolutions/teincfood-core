/**
 * POS Repository.
 *
 * Domain-specific operations for the POS terminal. Builds on OrderRepository
 * for commands and keeps read/query operations behind a repository interface.
 */

import { posService } from "../adapters/services";
import { orderRepository } from "./order.repository";
import type { POSOrderCreateRequest, POSOrderPreviewRequest, POSOrderPreviewResponse } from "../types/pos.types";
import type { SellerOrder } from "../types/api/seller.api";
import type { SellerOrdersResponse } from "../types/api/seller.api";

export interface POSOrderPreviewInput {
  businessId: string;
  items: POSOrderPreviewRequest["items"];
  orderType: POSOrderPreviewRequest["order_type"];
  customerName?: string;
}

export const posRepository = {
  async createOrder(
    businessId: string,
    data: POSOrderCreateRequest,
    entityId?: string,
  ): Promise<SellerOrder> {
    return orderRepository.createOrder({ businessId, data, entityId });
  },

  async fetchPreview(input: POSOrderPreviewInput): Promise<POSOrderPreviewResponse> {
    const res = await posService.fetchPOSOrderPreview(input.businessId, {
      items: input.items,
      order_type: input.orderType,
      customer_name: input.customerName,
    });
    return res as POSOrderPreviewResponse;
  },

  async fetchOrders(
    businessId: string,
    params?: Record<string, string>,
  ): Promise<SellerOrdersResponse> {
    const res = await posService.fetchBusinessOrders(businessId, params);
    return res as SellerOrdersResponse;
  },
};
