import { toast } from "sonner";
import { errorMessage, planLimitInfo } from "@/lib/auth/errors";

/** Error toast; plan restrictions point to the Billing page, where plans can be changed. */
export function toastError(error: unknown) {
  if (planLimitInfo(error)) {
    toast.error(errorMessage(error), { description: "Open Billing in the menu to see and change plans." });
    return;
  }
  toast.error(errorMessage(error));
}
