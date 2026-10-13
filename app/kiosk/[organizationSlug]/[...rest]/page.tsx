import { notFound } from "next/navigation";

/** Unknown kiosk screens render the kiosk-styled not-found instead of the marketing 404. */
export default function KioskUnknownScreen() {
  notFound();
}
