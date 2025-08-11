const muhammara = require("muhammara");
const fs = require("fs");
const path = require("path");
const { loadImage } = require("canvas"); // You'll need to install this: npm install canvas

/**
 * Combines PNG files from the trimmed folder into a single optimized PDF document
 */
async function combinePDFs() {
  const trimmedDir = path.join(__dirname, "../trimmed");

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

  // Analyze each PNG to get image information
  const imageInfo = await Promise.all(
    imageFiles.map(async (filePath) => {
      try {
        const image = await loadImage(filePath);
        return {
          path: filePath,
          filename: path.basename(filePath),
          width: image.width,
          height: image.height,
        };
      } catch (error) {
        console.error(`Error analyzing ${filePath}:`, error);
        return null;
      }
    })
  );

  // Filter out any nulls from failed analyses
  const validImages = imageInfo.filter((info) => info !== null);

  // Sort images to optimize page usage (by area - larger images first)
  const sortedImages = validImages.sort(
    (a, b) => b.width * b.height - a.width * a.height
  );

  // Create a new PDF writer
  const outputPath = path.join(__dirname, "../output", "combined.pdf");

  // Make sure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    // Create PDF writer
    const pdfWriter = muhammara.createWriter(outputPath);

    // Define standard page size (Letter size in points: 8.5" × 11")
    const pageWidth = 612; // 8.5" * 72
    const pageHeight = 792; // 11" * 72

    // Define margins in points (72 points = 1 inch)
    const margin = {
      top: 36, // 0.5 inch top margin
      bottom: 36, // 0.5 inch bottom margin
      left: 36, // 0.5 inch left margin
      right: 36, // 0.5 inch right margin
    };

    // Calculate usable area
    const usableWidth = pageWidth - margin.left - margin.right;
    const usableHeight = pageHeight - margin.top - margin.bottom;

    // Track current page and positioning
    let currentPage = null;
    let contentContext = null;
    let currentX = margin.left;
    let currentY = pageHeight - margin.top;
    let rowHeight = 0;
    let pageIndex = 0;

    // Create a new page
    function createNewPage() {
      if (currentPage) {
        contentContext.Q(); // Restore graphics state
        pdfWriter.writePage(currentPage);
      }

      currentPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      contentContext = pdfWriter.startPageContentContext(currentPage);
      contentContext.q(); // Save graphics state

      currentX = margin.left;
      currentY = pageHeight - margin.top;
      rowHeight = 0;
      pageIndex++;

      return { page: currentPage, context: contentContext };
    }

    // Create first page
    createNewPage();

    // Process each image
    for (const img of sortedImages) {
      console.log(`Processing ${img.filename} (${img.width}x${img.height})`);

      // Convert pixels to points - assuming 96 DPI source images
      const imageWidthInPoints = (img.width * 72) / 96;
      const imageHeightInPoints = (img.height * 72) / 96;

      // Check if image fits on current line
      if (currentX + imageWidthInPoints > pageWidth - margin.right) {
        // Move to next row
        currentX = margin.left;
        currentY -= rowHeight + 10; // Add 10 points of spacing between rows
        rowHeight = 0;
      }

      // Check if we need a new page
      if (currentY - imageHeightInPoints < margin.bottom) {
        createNewPage();
      }

      try {
        // Create an XObject using muhammara's API (choose by extension)
        let imageXObject;
        const ext = path.extname(img.path).toLowerCase();
        if (ext === ".png") {
          imageXObject = pdfWriter.createFormXObjectFromPNG(img.path);
        } else if (ext === ".jpg" || ext === ".jpeg") {
          imageXObject = pdfWriter.createImageXObjectFromJPG(img.path);
        } else {
          console.warn(`Skipping unsupported image type: ${img.filename}`);
          continue;
        }

        // Place the image at the desired size using a transformation matrix
        contentContext.q(); // Save graphics state
        contentContext.cm(
          imageWidthInPoints,
          0,
          0,
          imageHeightInPoints,
          currentX,
          currentY - imageHeightInPoints
        );
        contentContext.doXObject(imageXObject);
        contentContext.Q(); // Restore graphics state

        // Add a border for debugging (comment out in production)
        contentContext.q();
        contentContext.k(0, 0, 0, 1); // CMYK black
        contentContext.w(0.5); // Line width
        contentContext.re(
          currentX,
          currentY - imageHeightInPoints,
          imageWidthInPoints,
          imageHeightInPoints
        );
        contentContext.S(); // Stroke
        contentContext.Q();

        // Update positioning
        currentX += imageWidthInPoints + 10; // Add 10 points of spacing between images
        rowHeight = Math.max(rowHeight, imageHeightInPoints);

        console.log(
          `Placed ${img.filename} at (${currentX - imageWidthInPoints}, ${
            currentY - imageHeightInPoints
          }) with dimensions ${imageWidthInPoints}x${imageHeightInPoints}`
        );
      } catch (imgError) {
        console.error(`Error processing image ${img.filename}:`, imgError);
        // Continue with next image
      }
    }

    // Write the last page
    if (currentPage) {
      contentContext.Q(); // Restore graphics state
      pdfWriter.writePage(currentPage);
    }

    // Finalize the PDF
    pdfWriter.end();
    console.log(
      `Successfully combined ${sortedImages.length} images into ${outputPath}`
    );
    console.log(`Total pages: ${pageIndex}`);
  } catch (pdfError) {
    console.error("Error generating PDF:", pdfError);
  }
}

// Execute the function
combinePDFs().catch((error) => console.error("Error combining images:", error));
