"use client";

import { Button, InlineError, PageHeader } from "@sail/ui";

/** A page could not load from the register. Says what to do; the input (the URL) is kept. */
export default function BackofficeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title="The register did not reply" />
      <div className="flex max-w-[560px] flex-col items-start gap-4">
        <InlineError
          error={{
            message: process.env.NODE_ENV === "development" ? error.message : "This page could not be loaded from the register.",
            remedy: "Check that the API is running at the configured address, then try again.",
          }}
        />
        <Button variant="primary" onPress={reset}>
          Try again
        </Button>
      </div>
    </>
  );
}
