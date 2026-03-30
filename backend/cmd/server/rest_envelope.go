package main

import (
	"github.com/gin-gonic/gin"
)

func writeV1JSON(c *gin.Context, status int, data any, meta gin.H) {
	if meta == nil {
		meta = gin.H{}
	}
	c.JSON(status, gin.H{
		"data":  data,
		"error": nil,
		"meta":  meta,
	})
}

func writeV1Error(c *gin.Context, status int, code, message string, details any) {
	errObj := gin.H{"code": code, "message": message}
	if details != nil {
		errObj["details"] = details
	}
	c.JSON(status, gin.H{
		"data":  nil,
		"error": errObj,
		"meta":  gin.H{},
	})
}
