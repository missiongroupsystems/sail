"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button as AriaButton, Input, Label, Text, TextField as AriaTextField } from "react-aria-components";
import { cx } from "../lib/cx";
import { fieldControl, fieldDescription, fieldError, fieldLabel, fieldWrap } from "../components/field";
import { Icon } from "../components/Icon";
import { useLockedDisabled } from "../components/FieldsLocked";

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
export function TagsField({ label, description, errorMessage, value, onChange, placeholder = "Add a tag and press Enter", normalise = true, isDisabled: ownDisabled, isInvalid, className, ...rest }: TagsFieldProps) {
  const isDisabled = useLockedDisabled(ownDisabled);
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
      <div className={cx(fieldControl, "flex min-h-11 flex-wrap items-center gap-1.5 py-1.5 focus-within:bg-surface-3", isDisabled && "text-ink-disabled")}>
        {value.map((tag) => (
          <span key={tag} className={cx("inline-flex h-7 max-sm:h-11 items-center gap-1 rounded-chip pr-1 pl-2.5 text-caption font-medium", isDisabled ? "bg-surface-2 text-ink-disabled" : "bg-surface text-ink shadow-segment")}>
            {tag}
            <AriaButton
              aria-label={`Remove ${tag}`}
              isDisabled={isDisabled}
              onPress={() => onChange(value.filter((t) => t !== tag))}
              // A locked chip's × looks off, as other disabled controls do (M6).
              className={cx("inline-flex size-5 max-sm:size-11 items-center justify-center rounded-full outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus", isDisabled ? "cursor-not-allowed text-ink-disabled" : "press text-ink-2 data-[hovered]:bg-surface-2 data-[hovered]:text-ink")}
            >
              <Icon icon={X} size={12} />
            </AriaButton>
          </span>
        ))}
        <Input placeholder={value.length ? "" : placeholder} className="min-w-[8ch] flex-1 bg-transparent py-1 text-body text-ink outline-none placeholder:text-ink-3" />
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
