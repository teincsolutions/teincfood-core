/** Place autocomplete/detail types — backend places payloads. */

export interface PlaceSuggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface PlaceDetails {
  placeId: string;
  formattedAddress: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
}
