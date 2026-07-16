// ————————————————————————————————————————————————————————————————
// Sidebar display key ↔ internal activeTab key translator
// ————————————————————————————————————————————————————————————————

export type Mode = 'customer' | 'vendor';

export type InternalTab =
  | 'create'
  | 'view'
  | 'scpoAction'
  | 'inventoryCatalog'
  | 'customerProfile'
  | 'vendorProfile'
  | 'admin'
  | 'accounting'
  | 'financing'
  | 'marketplace'; // MARKETPLACE Task 5.2 Tier 3

export type DisplayTab =
  | 'create'
  | 'overview'
  | 'action'
  | 'inventory'
  | 'financing'
  | 'accounting'
  | 'profile'
  | 'marketplace'; // MARKETPLACE Task 5.2 Tier 3

export function displayToInternal(display: DisplayTab, mode: Mode): InternalTab {
  switch (display) {
    case 'create':     return 'create';
    case 'overview':   return 'view';
    case 'action':     return 'scpoAction';
    case 'inventory':  return 'inventoryCatalog';
    case 'financing':  return 'financing';
    case 'accounting': return 'accounting';
    case 'marketplace': return 'marketplace'; // MARKETPLACE Task 5.2 Tier 3
    case 'profile':    return mode === 'customer' ? 'customerProfile' : 'vendorProfile';
  }
}

export function internalToDisplay(internal: InternalTab): DisplayTab | null {
  switch (internal) {
    case 'create':            return 'create';
    case 'view':              return 'overview';
    case 'scpoAction':        return 'action';
    case 'inventoryCatalog':  return 'inventory';
    case 'financing':         return 'financing';
    case 'accounting':        return 'accounting';
    case 'marketplace':       return 'marketplace'; // MARKETPLACE Task 5.2 Tier 3
    case 'customerProfile':
    case 'vendorProfile':     return 'profile';
    case 'admin':             return null;
  }
}
