import Link from "next/link";

export default function NotFound() {
  return (
    <main data-scale="compact" className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center gap-2 px-6 text-body">
      <h1 className="text-title text-ink">There is no page here</h1>
      <p className="text-ink-2">
        The address may be out of date.{" "}
        <Link href="/today" className="text-ink underline underline-offset-4">
          Go to Today
        </Link>
        .
      </p>
    </main>
  );
}
