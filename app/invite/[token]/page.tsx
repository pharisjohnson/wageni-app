import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { InviteClient } from "./invite-client";

async function InviteToken({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteClient token={token} />;
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  // The token is request data, so it is read inside a Suspense boundary.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <InviteToken params={params} />
    </Suspense>
  );
}
