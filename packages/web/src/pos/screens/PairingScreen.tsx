"use client";

import { Button, cx, PinPad, SailLogo, TextField } from "@sail/ui";
import { useEffect, useRef, useState } from "react";
import { toApiError, type ApiError } from "@/lib/api";
import { pairStation } from "../api/register";
import { NOT_PAIRED, useApi } from "../hooks/useApi";
import type { Station } from "../api/types";
import { useStationStore } from "../state/station";
import { useSessionStore } from "../state/session";

export type PairingScreenProps = {
  /** What is being paired, in the copy: "iPad", or "screen" for a kitchen display. */
  device?: string;
  hint?: string;
  /** The station kind this device must pair with; the register refuses another kind before using the code. */
  kind?: Station["kind"];
  /** Where the token goes; the POS keeps it in its station store. The kitchen display passes its own. */
  onPaired?: (token: string, station: Station, label: string) => void;
};

/** Only the digits of what was typed or pasted ("123 456", "123-456"), six at most. */
const digitsOf = (text: string) => text.replace(/\D/g, "").slice(0, 6);

/**
 * First run: the 6-digit pairing code from the back office and a label for this iPad.
 *
 * On the iPad the code goes into a text field of its own, not the PIN pad: the next screen asks for a staff PIN on
 * that pad, and two six-digit pads one after the other read as one PIN asked twice. The field takes a pasted code.
 * Pairing waits for the button or Enter, so the device is named first: at the sixth digit it would pair under the
 * default name. A kitchen display keeps the on-screen keys (a wall screen may have no keyboard), and takes a pasted
 * code too.
 */
export function PairingScreen({ device = "iPad", hint = "In the back office, open Settings › Stations, choose the station and tap “Pair an iPad”. Enter the 6 digits here.", kind, onPaired }: PairingScreenProps = {}) {
  const api = useApi();
  const setPaired = useStationStore((s) => s.setPaired);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(kind === "display" ? "Kitchen display" : device);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  // Why this iPad is here again, when the register ended its pairing.
  const notPaired = useSessionStore((s) => (kind !== "display" && s.lockNote === NOT_PAIRED ? s.lockNote : null));
  const keys = kind === "display";

  // One request at a time: Enter and a tap on the button a moment later are one pairing, not two.
  const busy = useRef(false);
  const latest = useRef({ label, code });
  latest.current = { label, code };
  const pair = async (entered: string = code) => {
    const name = latest.current.label.trim();
    if (entered.length !== 6 || !name || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await pairStation(api, entered, name, kind);
      // Pairing ends every PIN session on this station, an old one left on this iPad included: forget it quietly, so the
      // lock screen does not open on "Your session ended" (A and C notes).
      useSessionStore.getState().lock(null);
      (onPaired ?? setPaired)(res.station_token, res.station, name);
    } catch (e) {
      // The code stays in place, so a slip can be corrected rather than typed again.
      setError(toApiError(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  /** A typed or pasted code; it pairs on the button or Enter. */
  const enter = (text: string) => {
    setCode(digitsOf(text));
    setError(null);
  };
  const entering = useRef({ enter, pair });
  entering.current = { enter, pair };
  // A code copied from the back office can be pasted anywhere on the screen, not only with the field focused.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("[data-device-name]")) return;
      const pasted = digitsOf(e.clipboardData?.getData("text") ?? "");
      if (!pasted) return;
      e.preventDefault();
      entering.current.enter(pasted);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
  // Digits from a keyboard go to the code when no field has the focus (a tap beside the field), as they did on the pad,
  // and Enter pairs. In a field, or on the button, Enter submits the form instead.
  useEffect(() => {
    if (keys) return;
    const onKey = (e: KeyboardEvent) => {
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) entering.current.enter(latest.current.code + e.key);
      else if (e.key === "Backspace") entering.current.enter(latest.current.code.slice(0, -1));
      else if (e.key === "Enter" && !(at instanceof HTMLButtonElement)) void entering.current.pair();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keys]);

  // The register's two answers are told apart by their words: an expired or replaced code needs a new one, a wrong one a second look.
  const problem = error ? [error.message, error.remedy].filter(Boolean).map((t) => t!.replace(/([^.!?])$/, "$1.")).join(" ") : null;

  const intro = (
    <div>
      <SailLogo size="card" />
      <h1 className="mt-5 font-heading text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink">Pair this {device} to a station</h1>
      {notPaired ? <p className="mt-2 text-[14.5px] text-ink">{notPaired}</p> : null}
      <p className="mt-2 text-[14.5px] text-ink-2">{hint}</p>
    </div>
  );
  const name = (
    <div data-device-name>
      <TextField label={`Name for this ${device}`} value={label} onChange={setLabel} placeholder="Bar iPad" inputClassName="min-h-14 text-line" maxLength={80} />
    </div>
  );
  // The error once. How to get a code is the line above. Its two lines are kept free while there is none, so the block,
  // centred on the screen, does not move the field under a finger when an error appears or changes length.
  const alert = (
    <p role="alert" className="min-h-[2lh] text-body text-status-alert">
      {problem}
    </p>
  );
  const button = (
    // On the iPad it is the form's submit button, so Enter in the code or the name field pairs; the display has no form.
    <Button variant="primary" size="lg" type={keys ? "button" : "submit"} isDisabled={code.length !== 6 || !label.trim()} isPending={pending} onPress={keys ? () => void pair() : undefined} className="w-full data-[disabled]:bg-transparent!">
      Pair this {device}
    </Button>
  );

  if (!keys) {
    return (
      <main className="flex h-dvh w-full items-center justify-center bg-bg px-8">
        <form
          className="flex w-full max-w-[440px] flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
        >
          {intro}
          {name}
          <TextField
            label="Pairing code from the back office"
            value={code}
            onChange={enter}
            placeholder="6 digits"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            isInvalid={Boolean(error)}
            description="Type it or paste it. Spaces and dashes are left out."
            inputClassName="min-h-16 text-center font-mono text-[28px] tracking-[0.3em] tabular placeholder:text-[18px] placeholder:tracking-normal"
          />
          {alert}
          {button}
        </form>
      </main>
    );
  }

  return (
    <main className="flex h-dvh w-full items-center justify-center bg-bg px-8">
      <div className="grid w-full max-w-[880px] grid-cols-[1fr_auto] items-center gap-16">
        <section className="flex max-w-[420px] flex-col gap-6">
          {intro}
          {name}
          {alert}
          {button}
        </section>
        <div className={cx("flex flex-col items-center gap-2 rounded-[20px] border bg-surface px-10 pt-9 pb-10 shadow-e2", error ? "border-status-alert" : "border-transparent")}>
          <p className="text-[14.5px] text-ink-2">Pairing code</p>
          <PinPad
            value={code}
            onChange={enter}
            onComplete={() => void 0}
            onEnter={() => void pair()}
            unlockHint={false}
            error={error ? error.message : null}
            showErrorText={false}
          />
        </div>
      </div>
    </main>
  );
}
