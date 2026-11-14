/**
 * @sail/ui: the components are the design.
 * Import the tokens and Tailwind layer from "@sail/ui/styles.css".
 */
export { cx } from "./lib/cx";
export { onAccent, accentText, contrastRatio, hexToRgb, luminance, type Rgb } from "./lib/contrast";

export { Icon, AgentMark, type IconProps } from "./components/Icon";
export { SailMark, SailLogo, type SailMarkProps, type SailLogoProps, type SailLogoSize } from "./components/SailLogo";
export { Button, LinkButton, type ButtonProps, type LinkButtonProps, type ButtonVariant, type ButtonSize } from "./components/Button";
export { TextField, type TextFieldProps } from "./components/TextField";
export { DateField, type DateFieldProps } from "./components/DateField";
export type { FieldSize } from "./components/field";
export { Select, type SelectProps, type SelectItem } from "./components/Select";
export { Switch, type SwitchProps } from "./components/Switch";
export { FieldsLocked, useFieldsLocked } from "./components/FieldsLocked";
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
export { Money, type MoneyProps } from "./components/Money";
export { BusinessDay } from "./components/BusinessDay";
export { LocaleProvider, useLocale } from "./lib/locale";
export { sortTaxes, taxRows, type TaxAmountLike, type TaxRow } from "./lib/tax";
export { soldOutText } from "./lib/sold-out";
export { makeLocaleFormat, localeFromAcceptLanguage, deviceLocale, deviceTimeZone, type LocaleFormat, type LocaleSettings, type MoneyFormatOptions } from "./lib/locale-format";
export { StatusDot, type StatusDotProps, type Status } from "./components/StatusDot";
export { Badge, KIND_TONE, kindTone, type BadgeProps, type BadgeTone } from "./components/Badge";
export { PageHeader, SectionHeading, type PageHeaderProps, type SectionHeadingProps } from "./components/PageHeader";
export { SideNav, sideNavLabelClass, sideNavRowClass, type SideNavProps, type NavItem, type NavLinkProps } from "./components/SideNav";

// Small presentational pieces for the restyled screens.
export { Eyebrow, type EyebrowProps } from "./components/Eyebrow";
export { Hairline, type HairlineProps } from "./components/Hairline";
export { Pill, type PillProps, type PillTone } from "./components/Pill";
export { StatCard, StatTile, StatTiles, type StatCardProps, type StatTilesProps } from "./components/StatCard";
export { SectionHead, type SectionHeadProps } from "./components/SectionHead";

// Back-office additions (v0.3): fields that hold the API's integers while the person types dollars and percentages.
export { MoneyField, type MoneyFieldProps } from "./backoffice/MoneyField";
export { PercentField, parsePercent, percentText, type PercentFieldProps } from "./backoffice/PercentField";
export { TagsField, type TagsFieldProps } from "./backoffice/TagsField";
export { SectionTabs, type SectionTabsProps, type SectionTab } from "./backoffice/SectionTabs";
export { DescriptionList, Stat, type DescriptionListProps, type DescriptionItem, type StatProps } from "./backoffice/DescriptionList";

// POS components (v0.4): the lock screen, floor plan and order entry.
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
export { likelyTendered } from "./pos/cash-given";
export { NowRail, type NowRailProps, type NowItem } from "./pos/NowRail";
export { PanelSheet, type PanelSheetProps } from "./pos/PanelSheet";

// Back-office additions (v0.9): the refund stepper's progress row and plain-text ticket previews.
export { Steps, type StepsProps, type Step } from "./backoffice/Steps";
export { TicketPreview, type TicketPreviewProps } from "./backoffice/TicketPreview";

// Guest app components (v0.8): Scan to Order on phones.
export { BottomSheet, type BottomSheetProps } from "./guest/BottomSheet";
export { BrandButton, type BrandButtonProps, type BrandButtonVariant } from "./guest/BrandButton";
export { GuestStepper, type GuestStepperProps } from "./guest/GuestStepper";
export { ChoiceGroup, type ChoiceGroupProps, type ChoiceOption, type ChoiceValue } from "./guest/ChoiceGroup";
export { RoundTimeline, type RoundTimelineProps, type RoundStage } from "./guest/RoundTimeline";
export { MenuItemRow, type MenuItemRowProps, type MenuItemState } from "./guest/MenuItemRow";
export { ScrollTabs, type ScrollTabsProps, type ScrollTab } from "./guest/ScrollTabs";
export { BillDocumentView, type BillDocumentViewProps, type BillDocumentLike } from "./guest/BillDocumentView";

// POS components (v0.6 to v0.8): bills, payment, cash count and the close-shift checklist.
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "./pos/SegmentedControl";
export { BillCard, type BillCardProps, type BillCardLine, type BillCardRow, type BillCardStatus } from "./pos/BillCard";
export { TenderGrid, type TenderGridProps, type Tender } from "./pos/TenderGrid";
export { CashCounter, cashCounterTotal, denominationsFrom, type CashCounterProps, type CashCounterMode, type Denomination } from "./pos/CashCounter";
export { Checklist, type ChecklistProps, type ChecklistItem, type ChecklistItemStatus } from "./pos/Checklist";
export { Panel, ValueRows, SheetSection, Group, type PanelProps, type ValueRowsProps, type SheetSectionProps, type GroupProps } from "./backoffice/Panel";
export { FilterTabs, type FilterTabsProps, type FilterTabOption } from "./backoffice/FilterTabs";
export { refundBlocks, refundableQuantity, type ReportBlocks, type ReportRow, type ReportSales, type ReportRefunds } from "./lib/report-blocks";
