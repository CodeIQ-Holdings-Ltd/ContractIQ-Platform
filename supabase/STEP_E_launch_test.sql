-- Go-live guide, Part E.

-- E1 · BEFORE testing: stop your own test account taking a founding place.
update founding_offer set offer_open = false where id = 1;

-- E3 · AFTER testing: open the founding offer again.
-- update founding_offer set offer_open = true where id = 1;
