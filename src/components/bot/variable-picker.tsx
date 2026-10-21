"use client";

/**
 * The `{}` button next to a text field: inserts a variable token.
 * Lists contact fields, the account's custom fields (by id, labelled by
 * name), the triggering message (automations), and any extra variables
 * the host knows about (collected flow answers, formatter outputs,
 * webhook payload paths). Tokens resolve via lib/bot/variables.
 */

import { useEffect, useState } from "react";
import { Braces } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ExtraVariable {
  token: string;
  label?: string;
}

let customFieldCache: { id: string; field_name: string }[] | null = null;

function useCustomFields() {
  const [fields, setFields] = useState(customFieldCache ?? []);
  useEffect(() => {
    if (customFieldCache) return;
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      let res = await supabase.from("custom_fields").select("id, field_name, archived_at").order("field_name");
      // Pre-044 databases have no archived_at; retry without it.
      if (res.error) res = (await supabase.from("custom_fields").select("id, field_name").order("field_name")) as typeof res;
      const rows = ((res.data ?? []) as { id: string; field_name: string; archived_at?: string | null }[]).filter(
        (f) => !f.archived_at,
      );
      customFieldCache = rows;
      if (!cancelled) setFields(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return fields;
}

export function VariablePicker({
  onInsert,
  extra = [],
  showMessage = false,
  showContact = true,
}: {
  onInsert: (token: string) => void;
  extra?: ExtraVariable[];
  showMessage?: boolean;
  showContact?: boolean;
}) {
  const t = useTranslations("BotStudio.variables");
  const customFields = useCustomFields();
  const wrap = (token: string) => `{{${token}}}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-primary hover:text-primary"
        aria-label={t("insert")}
        title={t("insert")}
      >
        <Braces className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto border-border bg-popover">
        {showContact && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("contact")}
            </DropdownMenuLabel>
            {(["name", "phone", "email", "company"] as const).map((f) => (
              <DropdownMenuItem key={f} onClick={() => onInsert(wrap(`contact.${f}`))}>
                {t(`fields.${f}`)}
              </DropdownMenuItem>
            ))}
            {customFields.map((f) => (
              <DropdownMenuItem key={f.id} onClick={() => onInsert(wrap(`contact.custom.${f.id}`))}>
                {f.field_name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {showMessage && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("message")}
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onInsert(wrap("message.text"))}>{t("messageText")}</DropdownMenuItem>
          </DropdownMenuGroup>
        )}
        {extra.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("variables")}
            </DropdownMenuLabel>
            {extra.map((v) => (
              <DropdownMenuItem key={v.token} onClick={() => onInsert(wrap(v.token))}>
                <span className="font-mono text-xs">{v.label ?? v.token}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
