/**
 * Timestamp utilities for session headers and file names.
 */

/**
 * Get a timestamp string for session headers and file names.
 *
 * - Default: ISO 8601 UTC format (compatible with standard parsing)
 * - Optional: can be configured to use local timezone via OPENCLAW_TIMESTAMP_TIMEZONE env var
 *
 * @param date - Optional date object to use (defaults to current time)
 * @returns ISO 8601 formatted timestamp string
 */
export function getSessionTimestamp(date?: Date): string {
  const d = date ?? new Date();

  // Check for timezone override via environment variable
  const timezone = process.env.OPENCLAW_TIMESTAMP_TIMEZONE;

  if (timezone) {
    try {
      // Validate timezone by attempting to use it
      Intl.DateTimeFormat(undefined, { timeZone: timezone });

      // Use Intl.DateTimeFormat for reliable formatting with milliseconds
      const year = d.toLocaleString("sv-SE", { timeZone: timezone, year: "numeric" });
      const month = d.toLocaleString("sv-SE", { timeZone: timezone, month: "2-digit" });
      const day = d.toLocaleString("sv-SE", { timeZone: timezone, day: "2-digit" });
      const hours = d.toLocaleString("sv-SE", {
        timeZone: timezone,
        hour: "2-digit",
        hour12: false,
      });
      const minutes = d.toLocaleString("sv-SE", { timeZone: timezone, minute: "2-digit" });
      const seconds = d.toLocaleString("sv-SE", { timeZone: timezone, second: "2-digit" });
      const milliseconds = d.getMilliseconds().toString().padStart(3, "0");

      // Format: YYYY-MM-DDTHH:mm:ss.sss (similar to ISO 8601 but without Z)
      return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}`;
    } catch {
      // If timezone is invalid, fall back to UTC
      return d.toISOString();
    }
  }

  // Default: standard ISO 8601 UTC format
  return d.toISOString();
}

/**
 * Format a timestamp for use in filenames (replaces : and . with -)
 *
 * @param date - Optional date object to use (defaults to current time)
 * @returns Timestamp string safe for use in filenames
 */
export function getFileTimestamp(date?: Date): string {
  return getSessionTimestamp(date).replace(/[:.]/g, "-");
}
