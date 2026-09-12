ContractIQ screenshots
======================

These four images are used in the ContractIQ section of index.html.
Each screen has two files:

  ciq-dashboard-thumb.jpg   1000x625   thumbnail shown in the grid
  ciq-dashboard.jpg         1600 wide  full size, shown in the lightbox

  ciq-features-thumb.jpg / ciq-features.jpg     capability overview
  ciq-fit-thumb.jpg      / ciq-fit.jpg          where ContractIQ sits
  ciq-security-thumb.jpg / ciq-security.jpg     data protection page

Thumbnails are cropped or padded to 16:10 so the grid stays even. The
markup points at the -thumb file in src and at the full file in data-full;
the lightbox reads data-full. If you replace an image, replace both files
and keep the names, or the lightbox will show the thumbnail enlarged.

Before replacing any of these
-----------------------------
Blur or replace any real supplier name, person's name, contract value or
email address. A screenshot of live customer data on a public website is a
personal data breach.

The dashboard figures currently shown are ContractIQ's own illustrative
example data, and the caption under the grid says so. Keep that caption if
the replacement screenshots also show example data, and change it if they
ever show anything real.

To regenerate from full-resolution captures
-------------------------------------------
Any image editor will do. The only requirements are:
  - thumbnails 1000x625 (16:10), full versions 1600px wide
  - JPEG, quality 85-90, progressive
  - keep each pair under about 250 KB total so the page stays fast
