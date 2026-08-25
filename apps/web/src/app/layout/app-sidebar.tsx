import { CaretUpDownIcon, CheckIcon, GearSixIcon } from '@phosphor-icons/react';
import { NavLink, useLocation, useNavigate } from 'react-router';

import { OrgBrand } from '@/components/shared/org-brand';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { MODULES, findModuleForPath, moduleVisibleFor, type ModuleDef, type NavItem } from '@/lib/nav';
import { usePermissions } from '@/lib/session/permissions';

function isVisible(item: NavItem, granted: ReadonlySet<string>): boolean {
  return !item.permission || granted.has(item.permission);
}

/**
 * REQ-O-01: one module's sidebar at a time, switched here.
 *
 * Rendered only when the account can see more than one module — for most
 * employees "Attendance" is the whole product, and a switcher with one entry
 * is furniture. Selection navigates to the module's home screen, because a
 * module with none of your current context is not a filter, it is a place.
 */
function ModuleSwitcher({
  current,
  visible,
}: {
  current: ModuleDef;
  visible: ModuleDef[];
}) {
  const navigate = useNavigate();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton aria-label="Switch module">
                <current.icon />
                <span className="font-medium">{current.label}</span>
                <CaretUpDownIcon className="ml-auto size-4 opacity-60" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            {visible.map((module) => (
              <DropdownMenuItem
                key={module.id}
                onClick={() => void navigate(module.home)}
              >
                <module.icon />
                <span>{module.label}</span>
                {module.id === current.id ? <CheckIcon className="ml-auto size-4" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar() {
  const granted = usePermissions();
  const location = useLocation();

  const module = findModuleForPath(location.pathname);
  const visibleModules = MODULES.filter((candidate) => moduleVisibleFor(candidate, granted));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgBrand />
        {visibleModules.length > 1 ? (
          <ModuleSwitcher current={module} visible={visibleModules} />
        ) : null}
      </SidebarHeader>

      {/* Anchor for the guided tour's first step. On the content rather than
          on one group, because which groups exist depends on the permission
          set and a tour cannot point at a group that was filtered away. */}
      <SidebarContent data-guide="nav.groups">
        {module.groups.map((group) => {
          const items = group.items.filter((item) => isVisible(item, granted));
          // A group whose every item is hidden by permission renders nothing
          // rather than an empty labelled section.
          if (items.length === 0) return null;

          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        render={<NavLink to={item.to} />}
                        isActive={location.pathname === item.to}
                        tooltip={item.label}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      {/*
        The workspace's screens are reached from here rather than from
        a group in the module's own list -- they outlive whichever module is
        open, so they sit below the module rather than inside it.
      */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<NavLink to="/administration" />}
              isActive={location.pathname === '/administration'}
              tooltip="Administration"
            >
              <GearSixIcon />
              <span>Administration</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
