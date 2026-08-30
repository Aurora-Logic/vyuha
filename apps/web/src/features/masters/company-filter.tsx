import { useState } from 'react';
import { BuildingsIcon, HouseLineIcon } from '@phosphor-icons/react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIntegrations } from '@/features/integrations/use-integrations';

export const ALL_COMPANIES = '__all_companies__';

export interface CompanyFilterProps {
  value: string;
  onValueChange: (connectionId: string | null) => void;
  className?: string;
}

export function CompanyFilter({ value, onValueChange, className = 'w-56' }: CompanyFilterProps) {
  const { data: integrationsData, isLoading } = useIntegrations();
  const connections = integrationsData?.data ?? [];
  const [selected, setSelected] = useState<string>(value || ALL_COMPANIES);
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setSelected(value || ALL_COMPANIES);
  }

  const handleSelectChange = (next: string | null) => {
    const nextVal = next ?? ALL_COMPANIES;
    setSelected(nextVal);
    if (nextVal === ALL_COMPANIES) {
      onValueChange(null);
    } else {
      onValueChange(nextVal);
    }
  };

  return (
    <Select
      value={selected}
      onValueChange={handleSelectChange}
      disabled={isLoading && connections.length === 0}
    >
      <SelectTrigger className={className} aria-label="Filter by Company">
        <SelectValue>
          {(val: string) => {
            if (!val || val === ALL_COMPANIES) {
              return (
                <span className="flex items-center gap-1.5 truncate">
                  <BuildingsIcon className="h-4 w-4 shrink-0 text-slate-500" />
                  <span>All Companies (Unified)</span>
                </span>
              );
            }
            const match = connections.find((c) => c.id === val);
            return (
              <span className="flex items-center gap-1.5 truncate">
                <HouseLineIcon className="h-4 w-4 shrink-0 text-blue-600" />
                <span className="truncate">{match?.companyName || match?.name || val}</span>
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_COMPANIES}>
          <span className="flex items-center gap-2">
            <BuildingsIcon className="h-4 w-4 text-slate-500" />
            <span className="font-medium">All Companies (Unified Group View)</span>
          </span>
        </SelectItem>
        {connections.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="flex items-center gap-2">
              <HouseLineIcon className="h-4 w-4 text-blue-600" />
              <span>{c.companyName || c.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
