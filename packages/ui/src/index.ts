/**
 * @sail/ui: the components are the design (design.md section 11.1).
 * Import the tokens and Tailwind layer from "@sail/ui/styles.css".
 */
export { cx } from "./lib/cx";

export { Icon, AgentMark, type IconProps } from "./components/Icon";
export { Button, LinkButton, type ButtonProps, type LinkButtonProps, type ButtonVariant, type ButtonSize } from "./components/Button";
export { TextField, type TextFieldProps } from "./components/TextField";
export { Select, type SelectProps, type SelectItem } from "./components/Select";
export { Switch, type SwitchProps } from "./components/Switch";
export { Checkbox, CheckboxGroup, type CheckboxProps, type CheckboxGroupProps } from "./components/Checkbox";
export { Sheet, type SheetProps } from "./components/Sheet";
export { Dialog, type DialogProps } from "./components/Dialog";
export { Menu, MenuItem, MenuSeparator, MenuTrigger, type MenuProps, type MenuItemProps } from "./components/Menu";
export { DataTable, type DataTableProps, type DataTableColumn, type DataTableSort, type SortValue } from "./components/DataTable";
export { ScopePicker, ALL as SCOPE_ALL, type ScopePickerProps, type ScopeOption, type ScopeValue } from "./components/ScopePicker";
export { EmptyState, type EmptyStateProps } from "./components/EmptyState";
export { Skeleton, type SkeletonProps } from "./components/Skeleton";
export { InlineError, type InlineErrorProps, type InlineErrorSource } from "./components/InlineError";
export { AttributionChip, initialsOf, type AttributionChipProps, type Attribution } from "./components/AttributionChip";
export { Money, formatCents, type MoneyProps, type FormatCentsOptions } from "./components/Money";
export { StatusDot, type StatusDotProps, type Status } from "./components/StatusDot";
export { Badge, type BadgeProps, type BadgeTone } from "./components/Badge";
export { PageHeader, SectionHeading, type PageHeaderProps, type SectionHeadingProps } from "./components/PageHeader";
export { SideNav, type SideNavProps, type NavItem, type NavLinkProps } from "./components/SideNav";
