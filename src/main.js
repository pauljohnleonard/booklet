const muhammara = require("muhammara");

const extractImageSizes = (pdfPath) => {
  const pdfReader = muhammara.createReader(pdfPath);
  const pageCount = pdfReader.getPagesCount();
  console.log(pageCount);

  for (let i = 0; i < pageCount; i++) {
    const page = pdfReader.parsePage(i);
    const resourcesDict = page.getDictionary().toJSObject().Resources;
    console.log("X");

    if (resourcesDict && resourcesDict.XObject) {
      console.log("A");
      const xObjects = resourcesDict.XObject.toJSObject();
      Object.keys(xObjects).forEach((key) => {
        const xObject = xObjects[key];
        if (
          xObject.getType() === "XObject" &&
          xObject.toJSObject().Subtype.value === "Image"
        ) {
          const imageDict = xObject.toJSObject();
          const width = imageDict.Width.value;
          const height = imageDict.Height.value;
          console.log(
            `Image on page ${i + 1}: Width = ${width}, Height = ${height}`
          );
        }
      });
    }
  }
};

const filename =
  "/Users/paulleonard/Library/CloudStorage/GoogleDrive-pauljohnleonard@gmail.com/My Drive/MUSIC/BalFolkFrome/flat/Batiska-Flute.pdf";

// Replace 'your-pdf-file.pdf' with your PDF file path
extractImageSizes(filename);
