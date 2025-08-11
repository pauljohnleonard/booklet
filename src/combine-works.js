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
  const outputPath = path.join(__dirname, "combined.pdf");

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
    top: 36, // 0.5 inch top margin
    bottom: 36, // 0.5 inch bottom margin
    left: 36, // 0.5 inch left margin
    right: 36, // 0.5 inch right margin
  };

  // Process each image
  for (const img of sortedImages) {
    console.log(`Adding ${img.filename} (${img.width}x${img.height})`);

    // Convert pixels to points - 72 DPI
    const imageWidthInPoints = (img.width * 72) / 96;
    const imageHeightInPoints = (img.height * 72) / 96;

    // Create page with image dimensions plus margins
    const pageWidth = imageWidthInPoints + margin.left + margin.right;
    const pageHeight = imageHeightInPoints + margin.top + margin.bottom;

    // Create page with image dimensions plus margins
    const page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);

    // Create a form XObject from the image
    const formXObject = pdfWriter.createFormXObjectFromPNG(img.path);

    // Use dimensions from our img object instead of trying to get them from formXObject
    const xObjectWidth = img.width;
    const xObjectHeight = img.height;

    // Place the image on the page
    const contentContext = pdfWriter.startPageContentContext(page);
    contentContext.q(); // Save graphics state

    // Calculate scaling factors to fit the image properly on the page
    const scaleX = imageWidthInPoints / xObjectWidth;
    const scaleY = imageHeightInPoints / xObjectHeight;

    // Apply proper transformation matrix (scale and position)
    // Format: cm(scaleX, skewX, skewY, scaleY, translateX, translateY)
    contentContext.cm(scaleX, 0, 0, scaleY, margin.left, margin.bottom);

    // Draw the image at the current position
    contentContext.doXObject(formXObject);

    contentContext.Q(); // Restore graphics state

    // End the page
    pdfWriter.writePage(page);
    pageIndex++;
  }

  // Finalize the PDF
  pdfWriter.end();
  console.log(
    `Successfully combined ${sortedImages.length} images into ${outputPath}`
  );
  console.log(`Total pages: ${pageIndex}`);
}

// Execute the function
combinePDFs().catch((error) => console.error("Error combining images:", error));
