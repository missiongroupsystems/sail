"use client";

import { Checkbox, CheckboxGroup, Select, Switch, TextField, type CheckboxGroupProps, type SelectProps, type SwitchProps, type TextFieldProps } from "@sail/ui";
import type { ReactNode } from "react";
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";

/** react-hook-form adapters for the ui fields, so forms stay declarative and errors land under the field. */

type Bound<T extends FieldValues> = { control: Control<T>; name: Path<T> };

export function RhfTextField<T extends FieldValues>({
  control,
  name,
  ...props
}: Bound<T> & Omit<TextFieldProps, "value" | "onChange" | "onBlur" | "isInvalid" | "errorMessage" | "name">) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          {...props}
          name={field.name}
          value={(field.value as string | undefined) ?? ""}
          onChange={field.onChange}
          onBlur={field.onBlur}
          isInvalid={!!fieldState.error}
          errorMessage={fieldState.error?.message}
        />
      )}
    />
  );
}

export function RhfSelect<T extends FieldValues>({
  control,
  name,
  ...props
}: Bound<T> & Omit<SelectProps, "selectedKey" | "onSelectionChange" | "isInvalid" | "errorMessage" | "name">) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Select
          {...props}
          name={field.name}
          selectedKey={(field.value as string | null | undefined) ?? null}
          onSelectionChange={(key) => field.onChange(key)}
          isInvalid={!!fieldState.error}
          errorMessage={fieldState.error?.message}
        />
      )}
    />
  );
}

export function RhfSwitch<T extends FieldValues>({ control, name, ...props }: Bound<T> & Omit<SwitchProps, "isSelected" | "onChange" | "name">) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => <Switch {...props} name={field.name} isSelected={Boolean(field.value)} onChange={field.onChange} onBlur={field.onBlur} />}
    />
  );
}

export type CheckboxOption = { id: string; label: string; description?: ReactNode };

export function RhfCheckboxGroup<T extends FieldValues>({
  control,
  name,
  options,
  emptyHint,
  ...props
}: Bound<T> & { options: CheckboxOption[]; emptyHint?: ReactNode } & Omit<CheckboxGroupProps, "value" | "onChange" | "children" | "isInvalid" | "errorMessage" | "name">) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <CheckboxGroup
          {...props}
          name={field.name}
          value={(field.value as string[] | undefined) ?? []}
          onChange={field.onChange}
          isInvalid={!!fieldState.error}
          errorMessage={fieldState.error?.message}
        >
          {options.length === 0 ? <p className="py-2 text-caption text-ink-2">{emptyHint ?? "Nothing to choose from yet."}</p> : null}
          {options.map((o) => (
            <Checkbox key={o.id} value={o.id} description={o.description}>
              {o.label}
            </Checkbox>
          ))}
        </CheckboxGroup>
      )}
    />
  );
}

/** A labelled group of fields inside a sheet. */
export function FormSection({ title, hint, children }: { title?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      {title ? (
        <div>
          <h3 className="text-line text-ink">{title}</h3>
          {hint ? <p className="text-caption text-ink-2">{hint}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
