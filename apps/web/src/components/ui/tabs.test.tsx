import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

// The sliding pill is a Base UI Indicator inside the list. jsdom has no
// layout, so the honest expectation is that it is rendered and kept hidden
// until the active tab has a measurable size; in a browser it appears under
// the active trigger and travels on change. A regression that dropped the
// element or rendered it before measurement would show here.
describe('Tabs indicator', () => {
  it('renders one indicator inside the list, hidden before layout settles', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">First</TabsTrigger>
          <TabsTrigger value="b">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>,
    );
    const list = screen.getByRole('tablist');
    const indicators = list.querySelectorAll('[data-slot="tabs-indicator"]');
    expect(indicators).toHaveLength(1);
    expect(indicators[0].hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('tab', { name: 'First' }).hasAttribute('data-active')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Second' }).hasAttribute('data-active')).toBe(false);
  });

  it('hides the indicator on the line variant, which keeps its own underline', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">First</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
      </Tabs>,
    );
    const indicator = screen.getByRole('tablist').querySelector('[data-slot="tabs-indicator"]');
    expect(indicator?.className).toContain('group-data-[variant=line]/tabs-list:hidden');
  });

  it('paints the accent variant: the travelling pill in the primary colour, the current label reversed out of it', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="accent">
          <TabsTrigger value="a">First</TabsTrigger>
          <TabsTrigger value="b">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
      </Tabs>,
    );
    const list = screen.getByRole('tablist');
    expect(list.getAttribute('data-variant')).toBe('accent');
    const indicator = list.querySelector('[data-slot="tabs-indicator"]');
    expect(indicator?.className).toContain('group-data-[variant=accent]/tabs-list:bg-primary');
    expect(screen.getByRole('tab', { name: 'First' }).className).toContain('group-data-[variant=accent]/tabs-list:data-active:text-primary-foreground');
  });
});
