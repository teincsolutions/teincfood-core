/**
 * Places search hooks — single source for both apps (previously verbatim
 * copies). Pure React + injected placesService; storage-backed caching lives
 * in the host service implementations.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { placesService } from "../adapters/services";
import type { PlaceSuggestion, PlaceDetails } from "../types/places";

export function usePlacesSearch(debounceMs = 300) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!query || query.length < 3) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await placesService.searchPlaces(query);
        if (!cancelled) {
          setSuggestions(results);
        }
      } catch (error) {
        try {
          console.error("Places search error:", error);
        } catch {}
        if (!cancelled) {
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      setIsLoading(false);
    };
  }, [query, debounceMs]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setSuggestions([]);
  }, []);

  const clearAll = useCallback(() => {
    setQuery("");
    setSuggestions([]);
    setIsLoading(false);
  }, []);

  return {
    query,
    setQuery,
    suggestions,
    isLoading,
    clearSearch,
    clearAll,
  };
}

export function usePlaceDetails(placeId: string | null) {
  const [details, setDetails] = useState<PlaceDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!placeId) {
      setDetails(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    placesService.getPlaceDetails(placeId).then((result) => {
      if (!cancelled && result) {
        setDetails(result);
      }
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [placeId]);

  return { details, isLoading };
}

export function clearPlacesCache() {
  void placesService.clearCache();
}

/** Generic debounced-value hook for search/filter inputs. */
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
