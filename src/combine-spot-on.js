import muhammara from "muhammara";
import fs from "fs";
import path from "path";
import imageSize from "image-size"; // npm install image-size

// Group images into the fewest page-sets using First-Fit Decreasing by scaled height
function groupImagesIntoPages(images, contentHeight, scale, imageGap) {
  const items = images
    .map((img) => ({
      ...img,
      scaledHeight: img.height * scale,
    }))
    .sort((a, b) => b.scaledHeight - a.scaledHeight);

  const pages = []; // each page: { items: [], used: number }
  for (const item of items) {
    let placed = false;
    for (const page of pages) {
      const needed = (page.used > 0 ? imageGap : 0) + item.scaledHeight;
      if (page.used + needed <= contentHeight) {
        page.items.push(item);
        page.used += needed;
        placed = true;
        break;
      }
    }
    if (!placed) {
      pages.push({ items: [item], used: item.scaledHeight });
    }
  }
  // Strip helper properties
  return pages.map((p) => p.items.map(({ scaledHeight, ...rest }) => rest));
}

/**
 * Combines PNG files from the trimmed folder into a single optimized PDF document
 */
async function combinePDFs() {
  const trimmedDir = "trimmed";

  // Check if directory exists
  if (!fs.existsSync(trimmedDir)) {
    console.error("Error: 'trimmed' directory not found!");
    return;
  }

  // Get all PNG files from the trimmed directory
  const imageFiles = fs
    .readdirSync(trimmedDir)
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .map((file) => path.join(trimmedDir, file));

  if (imageFiles.length === 0) {
    console.error("No PNG files found in the 'trimmed' directory!");
    return;
  }

  // Analyze each PNG to get image information (no canvas)
  const imageInfo = imageFiles.map((filePath) => {
    try {
      const buffer = fs.readFileSync(filePath);
      const { width, height } = imageSize(buffer);
      return {
        path: filePath,
        filename: path.basename(filePath),
        width,
        height,
      };
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
      return null;
    }
  });

  // Filter out any nulls from failed analyses
  const validImages = imageInfo.filter((info) => info !== null);

  // Previously this sorted by filename; we now group later to minimize pages
  if (validImages.length === 0) {
    console.error("No valid PNG files to render.");
    return;
  }

  // Create a new PDF writer
  const outputPath = "combined.pdf";

  // Make sure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create PDF writer
  const pdfWriter = muhammara.createWriter(outputPath);

  // Track the current page number in the combined PDF
  let pageIndex = 0;

  // Define margins in points (72 points = 1 inch)
  const margin = {
    top: 36,
    bottom: 36,
    left: 36,
    right: 36,
  };

  // A4 page size in points
  const pageWidth = 595.28;
  const pageHeight = 841.89;

  // Content area
  const contentWidth = pageWidth - margin.left - margin.right;
  const contentHeight = pageHeight - margin.top - margin.bottom;
  const pageLimitY = pageHeight - margin.top;

  // Compute a single global scale so the widest image fits horizontally
  const imageGap = 40;
  const maxWidthPx = Math.max(...validImages.map((i) => i.width));
  const scale = contentWidth / maxWidthPx; // To avoid upscaling, use: Math.min(1, contentWidth / maxWidthPx)

  // Group images into minimal page sets (order by best fit, not filename)
  const pages = groupImagesIntoPages(
    validImages,
    contentHeight,
    scale,
    imageGap
  );

  // Start first page
  let page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  let contentContext = pdfWriter.startPageContentContext(page);
  // Start from top margin for top-justified layout
  let currentY = pageHeight - margin.top;

  // Render page-by-page based on grouping
  for (let p = 0; p < pages.length; p++) {
    if (p > 0) {
      // finalize previous page and start a new one
      pdfWriter.writePage(page);
      pageIndex++;
      page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      contentContext = pdfWriter.startPageContentContext(page);
      currentY = pageHeight - margin.top;
    }

    for (const img of pages[p]) {
      const wPts = img.width * scale;
      const hPts = img.height * scale;

      // Safety: if something doesn't fit due to rounding, spill to a new page
      if (currentY - hPts < margin.bottom) {
        pdfWriter.writePage(page);
        pageIndex++;
        page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
        contentContext = pdfWriter.startPageContentContext(page);
        currentY = pageHeight - margin.top;
      }

      const x = margin.left + (contentWidth - wPts) / 2; // center horizontally
      const y = currentY - hPts; // place so image top sits at currentY

      contentContext.drawImage(x, y, img.path, {
        transformation: { width: wPts, height: hPts },
      });

      currentY -= hPts + imageGap;
    }
  }

  // Finalize the last page
  pdfWriter.writePage(page);
  pageIndex++;

  // Finalize the PDF
  pdfWriter.end();

  console.log(`Total pages: ${pageIndex}`);
}

// Execute the function
combinePDFs().catch((error) => console.error("Error combining images:", error));
