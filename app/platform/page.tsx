import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";

export default function PlatformHomePage() {
  return (
    <>
      <PageHeader
        title="Platform administration"
        description="Manage customer organizations and plans. Operator access never includes tenant visitor or staff records."
      />
      <div className="flex flex-wrap gap-2">
        <Link href="/platform/organizations" className={buttonVariants()}>
          Organizations
        </Link>
        <Link href="/platform/usage" className={buttonVariants({ variant: "outline" })}>
          Usage
        </Link>
      </div>
    </>
  );
}
