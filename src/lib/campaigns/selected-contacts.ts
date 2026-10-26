/**
 * Hand-off of contacts picked in the Customers table to the broadcast
 * wizard (/broadcasts/new?selected=1). sessionStorage, because a
 * selection can be far too long for a URL.
 */
export const SELECTED_CONTACTS_KEY = 'bluetick.broadcast.selectedContacts';
