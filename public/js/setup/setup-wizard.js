/**
 * SETUP WIZARD RETIRED.
 *
 * Customer accounts are created centrally by the Agency through Supabase.
 * The local (customer-facing) app never creates, activates or registers a
 * company. This module remains only as a hard redirect: any legacy link,
 * bookmark or hash-route that still points at the wizard lands on Login.
 */
(function () {
  'use strict';
  window.location.replace('/login.html');
})();
