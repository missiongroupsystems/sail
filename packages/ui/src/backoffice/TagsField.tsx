"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button as AriaButton, Input, Label, Text, TextField as AriaTextField } from "react-aria-components";
import { cx } from "../lib/cx";
import { fieldControl, fieldDescription, fieldError, fieldLabel, fieldWrap } from "../components/field";
import { Icon } from "../components/Icon";

export type TagsFieldProps = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  /** Lower-cases and trims each tag (default on): tags are matched by name in pricing scopes. */
  normalise?: boolean;
  isDisabled?: boolean;
  isInvalid?: boolean;
  "aria-label"?: string;
  className?: string;
};

/** Chips with a text input. Enter, comma or Tab adds the typed tag; each chip has a labelled remove button. */
export function TagsField({ label, description, errorMessage, value, onChange, placeholder = "Add a tag and press Enter", normalise = true, isDisabled, isInvalid, className, ...rest }: TagsFieldProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const raw = draft.split(",").map((t) => (normalise ? t.trim().toLowerCase() : t.trim())).filter(Boolean);
    if (raw.length === 0) return;
    const next = [...value];
    for (const t of raw) if (!next.includes(t)) next.push(t);
    onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Tab" && draft.trim()) {
      commit();
    } else if (e.key === "Backspace" && draft === "" && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <AriaTextField
      {...rest}
      value={draft}
      onChange={setDraft}
      onKeyDown={onKeyDown}
      onBlur={commit}
      isDisabled={isDisabled}
      isInvalid={isInvalid}
      validationBehavior="aria"
      className={cx(fieldWrap, className)}
    >
      {label ? <Label className={fieldLabel}>{label}</Label> : null}
      <div className={cx(fieldControl, "flex min-h-11 flex-wrap items-center gap-1.5 py-1.5", isDisabled && "opacity-50")}>
        {value.map((tag) => (
          <span key={tag} className="inline-flex h-7 items-center gap-1 rounded-chip bg-surface-2 pr-1 pl-2.5 text-caption text-ink">
            {tag}
            <AriaButton
              aria-label={`Remove ${tag}`}
              isDisabled={isDisabled}
              onPress={() => onChange(value.filter((t) => t !== tag))}
              className="press inline-flex size-5 items-center justify-center rounded-full text-ink-2 outline-none data-[hovered]:bg-line data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-status-seated"
            >
              <Icon icon={X} size={12} />
            </AriaButton>
          </span>
        ))}
        <Input placeholder={value.length ? "" : placeholder} className="min-w-[8ch] flex-1 bg-transparent py-1 text-body text-ink outline-none placeholder:text-ink-2/70" />
      </div>
      {description ? (
        <Text slot="description" className={fieldDescription}>
          {description}
        </Text>
      ) : null}
      {errorMessage ? <Text slot="errorMessage" className={fieldError}>{errorMessage}</Text> : null}
    </AriaTextField>
  );
}
