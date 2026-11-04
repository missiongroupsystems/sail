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

// Back-office additions (v0.3): fields that hold the API's integers while the person types dollars and percentages.
export { MoneyField, parseMoney, moneyText, type MoneyFieldProps } from "./backoffice/MoneyField";
export { PercentField, parsePercent, percentText, type PercentFieldProps } from "./backoffice/PercentField";
export { TagsField, type TagsFieldProps } from "./backoffice/TagsField";
export { SectionTabs, type SectionTabsProps, type SectionTab } from "./backoffice/SectionTabs";
export { DescriptionList, Stat, type DescriptionListProps, type DescriptionItem, type StatProps } from "./backoffice/DescriptionList";

// POS components (v0.4): the lock screen, floor plan and order entry (design 4.1 to 4.3, 4.7).
export { TILE_COLOURS, tileBand, type TileColour } from "./pos/tileColours";
export { PinPad, type PinPadProps } from "./pos/PinPad";
export { Tile, FolderTile, type TileProps, type FolderTileProps } from "./pos/Tile";
export { SectionRail, type SectionRailProps, type RailItem } from "./pos/SectionRail";
export { SearchField, type SearchFieldProps } from "./pos/SearchField";
export { SeatStrip, type SeatStripProps } from "./pos/SeatStrip";
export { QuantityStepper, type QuantityStepperProps } from "./pos/QuantityStepper";
export { LineRow, GroupHeader, type LineRowProps, type LineRowStatus, type GroupHeaderProps } from "./pos/LineRow";
export { TotalsBlock, type TotalsBlockProps, type TotalsRow } from "./pos/TotalsBlock";
export { ActionDock, type ActionDockProps, type DockAction } from "./pos/ActionDock";
export { UndoToast, type UndoToastProps } from "./pos/UndoToast";
export { Banner, BannerSlot, type BannerProps, type BannerTone } from "./pos/Banner";
export { TableShape, StatusLegend, TABLE_STATUS, type TableShapeProps, type TableStatus } from "./pos/TableShape";
export { TopBar, TopTabs, BackButton, ConnectionIndicator, type TopBarProps, type TopTabsProps, type TopTab, type ConnectionIndicatorProps, type ConnectionStatus } from "./pos/TopBar";
export { ReasonPicker, type ReasonPickerProps, type Reason, type PickedReason } from "./pos/ReasonPicker";
export { AmountPad, formatBpsText, type AmountPadProps } from "./pos/AmountPad";
export { NowRail, type NowRailProps, type NowItem } from "./pos/NowRail";
export { PanelSheet, type PanelSheetProps } from "./pos/PanelSheet";
