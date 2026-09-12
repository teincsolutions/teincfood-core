// Rider-related models

export interface RiderMetrics {
  today_earnings_minor: number;
  today_deliveries: number;
  available_deliveries: number;
  total_deliveries: number;
  status: string;
}

export interface RiderActiveDelivery {
  id: string;
  orderId: string;
  pickup: string;
  dropoff: string;
  status: 'assigned' | 'picked_up' | 'delivering' | 'delivered';
  estimatedTime: string;
}

export interface RiderEarnings {
  today: number;
  thisWeek: number;
  thisMonth: number;
  total: number;
  pendingPayout: number;
  currency: string;
}

export interface EarningsBreakdown {
  baseDeliveryFees: number;
  tipsReceived: number;
  bonuses: number;
  totalThisWeek: number;
  currency: string;
}

export interface RiderTransaction {
  id: string;
  orderId: string;
  amount: number;
  date: string;
  type: 'delivery' | 'bonus' | 'tip';
  currency: string;
}

export interface RiderStatistics {
  totalDeliveries: number;
  acceptanceRate: number;
  averageRating: number;
  totalEarnings: number;
  currency: string;
}

export interface DeliveryZone {
  id: string;
  name: string;
  enabled: boolean;
  radius: string;
  deliveries: number;
  latitude: number;
  longitude: number;
}

export interface NavigationSettings {
  selectedApp: 'google_maps' | 'apple_maps' | 'waze';
  autoStart: boolean;
  avoidTolls: boolean;
  avoidHighways: boolean;
}

export interface NavigationApp {
  id: string;
  name: string;
  description: string;
  icon: string;
  installed: boolean;
}